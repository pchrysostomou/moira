//! The decisions an executor asks for, and the two policies that answer them.

use std::collections::BTreeMap;

use crate::pcg32::{Pcg32, stream};

/// A task as the executor names it.
pub type TaskId = u64;

/// Which policy a run uses. Recorded in the trace header so a replay knows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    /// Every choice uniformly at random. Fair, so liveness holds; finds deep bugs slowly.
    Uniform,
    /// PCT with the given bug depth: random priorities, the highest runnable task always
    /// runs, and `depth - 1` change points drop the running task to the bottom. Finds a
    /// bug of depth `d` with probability at least `1 / (n * k^(d-1))` per run.
    Pct {
        /// The bug depth the run targets; at least 1.
        depth: u32,
    },
}

impl Policy {
    /// The per-run choice: half the seeds run uniform, half run PCT with depth 2, 3 or 4.
    #[must_use]
    pub fn for_seed(seed: u64) -> Policy {
        match seed % 4 {
            0 | 1 => Policy::Uniform,
            _ => Policy::Pct {
                depth: 2 + u32::try_from((seed >> 2) % 3).expect("fits"),
            },
        }
    }

    /// The name written to the header: `uniform` or `pct-<depth>`.
    #[must_use]
    pub fn name(self) -> String {
        match self {
            Policy::Uniform => "uniform".to_owned(),
            Policy::Pct { depth } => format!("pct-{depth}"),
        }
    }

    /// A scheduler for this policy on `seed`. `expected_polls` is PCT's estimate of the
    /// run length, used to place change points; it is ignored by `Uniform`.
    #[must_use]
    pub fn scheduler(self, seed: u64, expected_polls: u64) -> Box<dyn Scheduler> {
        match self {
            Policy::Uniform => Box::new(Uniform::new(seed)),
            Policy::Pct { depth } => Box::new(Pct::new(seed, depth, expected_polls)),
        }
    }
}

/// What a deterministic executor asks the policy.
pub trait Scheduler {
    /// The policy in force.
    fn policy(&self) -> Policy;
    /// A task exists from now on; PCT draws its priority here.
    fn spawned(&mut self, task: TaskId);
    /// A task is gone; bookkeeping only.
    fn finished(&mut self, task: TaskId);
    /// Which of `runnable` polls next, as an index. `runnable` is non-empty.
    fn choose(&mut self, runnable: &[TaskId]) -> usize;
    /// A fair bit from `node`'s own scheduling substream, for symmetric choices inside a
    /// task such as which of two ready futures to serve first. Fair under every policy:
    /// a biased coin would let a flood of ready messages starve a timer.
    fn coin(&mut self, node: u32) -> bool;
}

/// Per-node coin streams, shared by both policies.
#[derive(Debug, Default)]
struct Coins {
    seed: u64,
    streams: BTreeMap<u32, Pcg32>,
}

impl Coins {
    fn flip(&mut self, node: u32) -> bool {
        let seed = self.seed;
        let rng = self
            .streams
            .entry(node)
            .or_insert_with(|| stream(seed, &format!("n{node}/sched")));
        rng.next_u32() & 1 == 1
    }
}

/// Uniform random scheduling from the `sched` substream.
#[derive(Debug)]
pub struct Uniform {
    rng: Pcg32,
    coins: Coins,
}

impl Uniform {
    /// A uniform scheduler on `seed`.
    #[must_use]
    pub fn new(seed: u64) -> Self {
        Self {
            rng: stream(seed, "sched"),
            coins: Coins {
                seed,
                streams: BTreeMap::new(),
            },
        }
    }
}

impl Scheduler for Uniform {
    fn policy(&self) -> Policy {
        Policy::Uniform
    }

    fn spawned(&mut self, _task: TaskId) {}

    fn finished(&mut self, _task: TaskId) {}

    fn choose(&mut self, runnable: &[TaskId]) -> usize {
        assert!(!runnable.is_empty(), "choose called with no runnable task");
        usize::try_from(self.rng.below(runnable.len() as u64)).expect("index fits usize")
    }

    fn coin(&mut self, node: u32) -> bool {
        self.coins.flip(node)
    }
}

/// PCT (Burckhardt et al., ASPLOS 2010) over tasks: each task gets a random priority at
/// spawn, [`choose`](Scheduler::choose) returns the highest-priority runnable task, and
/// at each of `depth - 1` change points, drawn uniformly over the first `expected_polls`
/// polls, the chosen task's priority drops below every other. Ties cannot happen: random
/// priorities live above 2^63 and demoted ones count down from just below it.
///
/// In a discrete-event executor a choice only arises when several tasks are runnable at
/// the same instant, and time moves only when none is, so the unfairness PCT relies on
/// is bounded to one instant.
#[derive(Debug)]
pub struct Pct {
    depth: u32,
    rng: Pcg32,
    coins: Coins,
    priorities: BTreeMap<TaskId, u64>,
    polls: u64,
    change_points: Vec<u64>,
    next_demoted: u64,
}

const RANDOM_FLOOR: u64 = 1 << 63;

impl Pct {
    /// A PCT scheduler on `seed` targeting bug depth `depth`, with change points placed
    /// over an expected run of `expected_polls` polls. A depth of 1 has no change points.
    #[must_use]
    pub fn new(seed: u64, depth: u32, expected_polls: u64) -> Self {
        let mut rng = stream(seed, "sched");
        let span = expected_polls.max(1);
        let mut change_points: Vec<u64> = (1..depth).map(|_| rng.below(span)).collect();
        change_points.sort_unstable();
        change_points.reverse(); // pop() yields the earliest
        Self {
            depth: depth.max(1),
            rng,
            coins: Coins {
                seed,
                streams: BTreeMap::new(),
            },
            priorities: BTreeMap::new(),
            polls: 0,
            change_points,
            next_demoted: RANDOM_FLOOR - 1,
        }
    }

    /// Change points not yet reached, earliest first.
    #[must_use]
    pub fn pending_change_points(&self) -> Vec<u64> {
        self.change_points.iter().rev().copied().collect()
    }

    fn priority(&mut self, task: TaskId) -> u64 {
        if let Some(&p) = self.priorities.get(&task) {
            return p;
        }
        let p = RANDOM_FLOOR | (self.rng.next_u64() >> 1);
        self.priorities.insert(task, p);
        p
    }
}

impl Scheduler for Pct {
    fn policy(&self) -> Policy {
        Policy::Pct { depth: self.depth }
    }

    fn spawned(&mut self, task: TaskId) {
        self.priority(task);
    }

    fn finished(&mut self, task: TaskId) {
        self.priorities.remove(&task);
    }

    fn choose(&mut self, runnable: &[TaskId]) -> usize {
        assert!(!runnable.is_empty(), "choose called with no runnable task");
        let mut best = 0;
        let mut best_priority = 0;
        for (i, &task) in runnable.iter().enumerate() {
            let p = self.priority(task);
            if i == 0 || p > best_priority {
                best = i;
                best_priority = p;
            }
        }
        let poll = self.polls;
        self.polls += 1;
        if self.change_points.last().is_some_and(|&at| at <= poll) {
            self.change_points.pop();
            self.priorities.insert(runnable[best], self.next_demoted);
            self.next_demoted -= 1;
        }
        best
    }

    fn coin(&mut self, node: u32) -> bool {
        self.coins.flip(node)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn for_seed_splits_the_seeds_and_names_the_policy() {
        assert_eq!(Policy::for_seed(0), Policy::Uniform);
        assert_eq!(Policy::for_seed(1), Policy::Uniform);
        assert_eq!(Policy::for_seed(2), Policy::Pct { depth: 2 });
        assert_eq!(Policy::for_seed(3), Policy::Pct { depth: 2 });
        assert_eq!(Policy::for_seed(6), Policy::Pct { depth: 3 });
        assert_eq!(Policy::for_seed(10), Policy::Pct { depth: 4 });
        assert_eq!(Policy::for_seed(14), Policy::Pct { depth: 2 });
        assert_eq!(Policy::Uniform.name(), "uniform");
        assert_eq!(Policy::Pct { depth: 3 }.name(), "pct-3");
        let uniform = (0..1000)
            .filter(|&s| Policy::for_seed(s) == Policy::Uniform)
            .count();
        assert_eq!(uniform, 500);
    }

    #[test]
    fn uniform_is_deterministic_and_covers_every_index() {
        let runnable = [10, 11, 12, 13];
        let picks = |seed: u64| -> Vec<usize> {
            let mut s = Uniform::new(seed);
            (0..64).map(|_| s.choose(&runnable)).collect()
        };
        assert_eq!(picks(5), picks(5));
        assert_ne!(picks(5), picks(6));
        let mut seen = [false; 4];
        for i in picks(5) {
            seen[i] = true;
        }
        assert!(seen.iter().all(|&s| s));
    }

    #[test]
    fn coins_are_fair_per_node_and_independent_of_choices() {
        let mut a = Uniform::new(3);
        let mut b = Uniform::new(3);
        let heads_a: Vec<bool> = (0..32).map(|_| a.coin(1)).collect();
        // Interleaving choose() calls on b must not change node 1's coins.
        let heads_b: Vec<bool> = (0..32)
            .map(|_| {
                b.choose(&[1, 2, 3]);
                b.coin(1)
            })
            .collect();
        assert_eq!(heads_a, heads_b);
        let other_node: Vec<bool> = (0..32).map(|_| a.coin(2)).collect();
        assert_ne!(heads_a, other_node);
        let heads = (0..2000).filter(|_| a.coin(1)).count();
        assert!((850..=1150).contains(&heads), "{heads}");
    }

    #[test]
    fn pct_runs_the_highest_priority_until_a_change_point_demotes_it() {
        let mut s = Pct::new(9, 2, 10);
        let runnable = [1, 2, 3];
        for t in runnable {
            s.spawned(t);
        }
        let change = s.pending_change_points();
        assert_eq!(change.len(), 1);
        let at = change[0];
        assert!(at < 10);
        let first = s.choose(&runnable);
        // Before the change point the same task wins every time.
        for _ in 1..at {
            assert_eq!(s.choose(&runnable), first);
        }
        // The change point demotes the winner; from then on another task wins.
        if at > 0 {
            assert_eq!(
                s.choose(&runnable),
                first,
                "the change point applies after the choice at that poll"
            );
        }
        let after = s.choose(&runnable);
        assert_ne!(after, first);
        for _ in 0..5 {
            assert_eq!(s.choose(&runnable), after);
        }
        assert!(s.pending_change_points().is_empty());
        assert_eq!(s.policy(), Policy::Pct { depth: 2 });
    }

    #[test]
    fn pct_is_deterministic_and_depth_one_never_changes_priority() {
        let run = |seed: u64| -> Vec<usize> {
            let mut s = Pct::new(seed, 3, 50);
            let runnable = [7, 8, 9, 10];
            (0..50).map(|_| s.choose(&runnable)).collect()
        };
        assert_eq!(run(4), run(4));
        assert_ne!(run(4), run(5));
        let mut flat = Pct::new(4, 1, 50);
        let runnable = [7, 8, 9, 10];
        let first = flat.choose(&runnable);
        assert!((0..50).all(|_| flat.choose(&runnable) == first));
        assert!(flat.pending_change_points().is_empty());
    }

    #[test]
    fn policies_come_boxed_for_the_executor() {
        let mut s = Policy::for_seed(2).scheduler(2, 100);
        s.spawned(1);
        s.spawned(2);
        assert!(s.choose(&[1, 2]) < 2);
        s.finished(1);
        let _ = s.coin(1);
        assert_eq!(s.policy(), Policy::Pct { depth: 2 });
    }
}
