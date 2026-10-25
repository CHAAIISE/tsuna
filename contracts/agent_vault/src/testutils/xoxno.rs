//! XOXNO controller double that is also its own central pool: one account per supply with 0.

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Map, Vec};

use crate::adapters::xoxno::HubAssetKey;

#[contracttype]
#[derive(Clone)]
pub struct AccountPositionRaw {
    pub liquidation_bonus: u32,
    pub liquidation_fees: u32,
    pub liquidation_threshold: u32,
    pub loan_to_value: u32,
    pub scaled_amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct DebtPositionRaw {
    pub scaled_amount: i128,
}

#[contracttype]
#[derive(Clone)]
enum XoKey {
    Next,
    Owner(u64),
    Collateral(u64),
    Debt(u64),
}

pub(crate) const THRESHOLD: u32 = 8_000;

#[contract]
pub struct XoxnoMock;

impl XoxnoMock {
    fn owned(env: &Env, caller: &Address, id: u64) {
        let owner: Address = env.storage().instance().get(&XoKey::Owner(id)).unwrap();
        assert_eq!(owner, *caller, "AccountNotInMarket");
    }

    fn book(env: &Env, key: XoKey) -> Map<HubAssetKey, i128> {
        env.storage().instance().get(&key).unwrap_or(Map::new(env))
    }
}

#[contractimpl]
impl XoxnoMock {
    pub fn get_pool_address(env: Env) -> Address {
        env.current_contract_address()
    }

    pub fn account_exists(env: Env, account_id: u64) -> bool {
        env.storage().instance().has(&XoKey::Owner(account_id))
    }

    pub fn supply(
        env: Env,
        caller: Address,
        account_id: u64,
        _spoke_id: u32,
        assets: Vec<(HubAssetKey, i128)>,
    ) -> u64 {
        caller.require_auth();
        let s = env.storage().instance();
        let id = if account_id == 0 {
            let id: u64 = s.get(&XoKey::Next).unwrap_or(1);
            s.set(&XoKey::Next, &(id + 1));
            s.set(&XoKey::Owner(id), &caller);
            id
        } else {
            Self::owned(&env, &caller, account_id);
            account_id
        };
        let mut book = Self::book(&env, XoKey::Collateral(id));
        for (key, amount) in assets {
            token::Client::new(&env, &key.asset).transfer(
                &caller,
                env.current_contract_address(),
                &amount,
            );
            book.set(key.clone(), book.get(key).unwrap_or(0) + amount);
        }
        s.set(&XoKey::Collateral(id), &book);
        id
    }

    pub fn withdraw(
        env: Env,
        caller: Address,
        account_id: u64,
        withdrawals: Vec<(HubAssetKey, i128)>,
        to: Option<Address>,
    ) -> Vec<(HubAssetKey, i128)> {
        caller.require_auth();
        Self::owned(&env, &caller, account_id);
        let mut book = Self::book(&env, XoKey::Collateral(account_id));
        let mut out = Vec::new(&env);
        let to = to.unwrap_or(caller);
        for (key, amount) in withdrawals {
            let held = book.get(key.clone()).unwrap_or(0);
            let amount = if amount == 0 || amount >= held {
                held
            } else {
                amount
            };
            book.set(key.clone(), held - amount);
            token::Client::new(&env, &key.asset).transfer(
                &env.current_contract_address(),
                &to,
                &amount,
            );
            out.push_back((key, amount));
        }
        env.storage()
            .instance()
            .set(&XoKey::Collateral(account_id), &book);
        out
    }

    pub fn borrow(
        env: Env,
        caller: Address,
        account_id: u64,
        borrows: Vec<(HubAssetKey, i128)>,
        to: Option<Address>,
    ) {
        caller.require_auth();
        Self::owned(&env, &caller, account_id);
        let mut book = Self::book(&env, XoKey::Debt(account_id));
        let to = to.unwrap_or(caller);
        for (key, amount) in borrows {
            book.set(key.clone(), book.get(key.clone()).unwrap_or(0) + amount);
            token::Client::new(&env, &key.asset).transfer(
                &env.current_contract_address(),
                &to,
                &amount,
            );
        }
        env.storage()
            .instance()
            .set(&XoKey::Debt(account_id), &book);
    }

    /// Anyone may repay any account; the excess is never taken.
    pub fn repay(env: Env, caller: Address, account_id: u64, payments: Vec<(HubAssetKey, i128)>) {
        caller.require_auth();
        let mut book = Self::book(&env, XoKey::Debt(account_id));
        for (key, amount) in payments {
            let owed = book.get(key.clone()).unwrap_or(0);
            let paid = amount.min(owed);
            token::Client::new(&env, &key.asset).transfer(
                &caller,
                env.current_contract_address(),
                &paid,
            );
            book.set(key, owed - paid);
        }
        env.storage()
            .instance()
            .set(&XoKey::Debt(account_id), &book);
    }

    /// Interest accrued on a debt.
    pub fn accrue(env: Env, account_id: u64, key: HubAssetKey, amount: i128) {
        let mut book = Self::book(&env, XoKey::Debt(account_id));
        book.set(key.clone(), book.get(key).unwrap_or(0) + amount);
        env.storage()
            .instance()
            .set(&XoKey::Debt(account_id), &book);
    }

    pub fn get_account_positions(
        env: Env,
        account_id: u64,
    ) -> (
        Map<HubAssetKey, AccountPositionRaw>,
        Map<HubAssetKey, DebtPositionRaw>,
    ) {
        let mut collateral = Map::new(&env);
        for (key, amount) in Self::book(&env, XoKey::Collateral(account_id)) {
            if amount > 0 {
                collateral.set(
                    key,
                    AccountPositionRaw {
                        liquidation_bonus: 500,
                        liquidation_fees: 100,
                        liquidation_threshold: THRESHOLD,
                        loan_to_value: 7_500,
                        scaled_amount: amount,
                    },
                );
            }
        }
        let mut debts = Map::new(&env);
        for (key, amount) in Self::book(&env, XoKey::Debt(account_id)) {
            if amount > 0 {
                debts.set(
                    key,
                    DebtPositionRaw {
                        scaled_amount: amount,
                    },
                );
            }
        }
        (collateral, debts)
    }

    pub fn get_collateral_amount(env: Env, account_id: u64, hub_asset: HubAssetKey) -> i128 {
        Self::book(&env, XoKey::Collateral(account_id))
            .get(hub_asset)
            .unwrap_or(0)
    }

    pub fn get_borrow_amount(env: Env, account_id: u64, hub_asset: HubAssetKey) -> i128 {
        Self::book(&env, XoKey::Debt(account_id))
            .get(hub_asset)
            .unwrap_or(0)
    }
}
