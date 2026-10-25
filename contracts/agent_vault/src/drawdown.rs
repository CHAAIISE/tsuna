use soroban_sdk::{contracttype, vec, Env, Vec};

use crate::{leash, shares, Error, Key, BPS};

const WINDOW: u64 = 86_400;
const HISTORY_TTL: u32 = 34_560;

#[contracttype]
#[derive(Clone)]
struct Summary {
    first: u64,
    last: u64,
    price: i128,
}

/// Leaves have no children; inner nodes keep their children's summaries (left, then right).
#[contracttype]
#[derive(Clone)]
struct Node {
    summary: Summary,
    children: Vec<Summary>,
}

fn height(count: u32) -> u32 {
    u32::BITS - (count - 1).leading_zeros()
}

fn load(env: &Env, level: u32, index: u32) -> Node {
    env.storage()
        .persistent()
        .get(&Key::Peak(level, index))
        .unwrap()
}

pub(crate) fn record(env: &Env, price: i128) -> Result<(), Error> {
    if shares::total(env) == 0 {
        return Ok(());
    }
    let count: u32 = env
        .storage()
        .instance()
        .get(&Key::Observations)
        .unwrap_or(0);
    let next = count.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
    let now = env.ledger().timestamp();
    let mut node = Node {
        summary: Summary {
            first: now,
            last: now,
            price,
        },
        children: Vec::new(env),
    };
    let mut index = count;
    // Observation indices, not timestamps, determine the write footprint.
    // Parent summaries let queries skip expired subtrees without restoring them.
    for level in 0..=height(next) {
        let key = Key::Peak(level, index);
        env.storage().persistent().set(&key, &node);
        env.storage()
            .persistent()
            .extend_ttl(&key, HISTORY_TTL / 2, HISTORY_TTL);
        if level == height(next) {
            break;
        }
        let children = if index.is_multiple_of(2) {
            vec![env, node.summary]
        } else {
            let parent: Option<Node> = env
                .storage()
                .persistent()
                .get(&Key::Peak(level + 1, index / 2));
            let left = parent
                .and_then(|p| p.children.get(0))
                .unwrap_or_else(|| load(env, level, index - 1).summary);
            vec![env, left, node.summary]
        };
        let left = children.get_unchecked(0);
        let right = children.get(1);
        let summary = Summary {
            first: left.first,
            last: right.as_ref().map_or(left.last, |r| r.last),
            price: left.price.max(right.as_ref().map_or(0, |r| r.price)),
        };
        node = Node { summary, children };
        index /= 2;
    }
    env.storage().instance().set(&Key::Observations, &next);
    Ok(())
}

fn query(env: &Env, level: u32, index: u32, summary: &Summary, cutoff: u64) -> i128 {
    if summary.last < cutoff {
        return 0;
    }
    if summary.first >= cutoff {
        return summary.price;
    }
    let node = load(env, level, index);
    let mut peak = 0;
    for (offset, child) in node.children.iter().enumerate() {
        peak = peak.max(query(
            env,
            level - 1,
            index * 2 + offset as u32,
            &child,
            cutoff,
        ));
    }
    peak
}

pub(crate) fn peak(env: &Env) -> i128 {
    let count: u32 = env
        .storage()
        .instance()
        .get(&Key::Observations)
        .unwrap_or(0);
    if count == 0 {
        return 0;
    }
    let level = height(count);
    let root = load(env, level, 0);
    query(
        env,
        level,
        0,
        &root.summary,
        env.ledger().timestamp().saturating_sub(WINDOW - 1),
    )
}

pub(crate) fn breached(env: &Env, price: i128) -> Result<bool, Error> {
    let floor = shares::mul_div(
        env,
        peak(env),
        BPS - i128::from(leash::limits(env).max_drawdown_bps),
        BPS,
        true,
    )?;
    Ok(price < floor)
}
