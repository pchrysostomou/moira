//! PCG32 XSH-RR, transcribed from `pcg_basic.c` (Melissa O'Neill, Apache-2.0) exactly as
//! the engine's `pcg32.ts` transcribes it, so a seed produces the same stream here.

use moirae_trace::fnv1a64;

const MUL: u64 = 6_364_136_223_846_793_005;

/// A PCG32 generator: 64 bits of state, a stream selector, 32-bit output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    /// `pcg32_srandom_r`: `state = 0; inc = (init_seq << 1) | 1; step; state += init_state; step`.
    #[must_use]
    pub fn new(init_state: u64, init_seq: u64) -> Self {
        let mut rng = Self {
            state: 0,
            inc: (init_seq << 1) | 1,
        };
        rng.next_u32();
        rng.state = rng.state.wrapping_add(init_state);
        rng.next_u32();
        rng
    }

    /// `pcg32_random_r`: the output comes from the old state, then the LCG advances.
    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(MUL).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Two draws, the first as the high word.
    pub fn next_u64(&mut self) -> u64 {
        (u64::from(self.next_u32()) << 32) | u64::from(self.next_u32())
    }

    /// Uniform in `0..bound` by rejection sampling, so it is unbiased.
    ///
    /// # Panics
    ///
    /// If `bound` is zero.
    pub fn below(&mut self, bound: u64) -> u64 {
        assert!(bound > 0, "below called with bound 0");
        let zone = u64::MAX - (u64::MAX % bound);
        loop {
            let draw = self.next_u64();
            if draw < zone {
                return draw % bound;
            }
        }
    }

    /// `true` with probability `p`, compared in 53 bits so no float is ever formatted;
    /// `p <= 0` is never and `p >= 1` always.
    pub fn chance(&mut self, p: f64) -> bool {
        if p <= 0.0 {
            return false;
        }
        if p >= 1.0 {
            return true;
        }
        let threshold = (p * (1u64 << 53) as f64) as u64;
        (self.next_u64() >> 11) < threshold
    }

    /// Fills `dest` from consecutive draws.
    pub fn fill_bytes(&mut self, dest: &mut [u8]) {
        for chunk in dest.chunks_mut(4) {
            let bytes = self.next_u32().to_le_bytes();
            chunk.copy_from_slice(&bytes[..chunk.len()]);
        }
    }
}

/// A named substream of `seed`: state `fnv1a64("{seed}/{label}")`, selector
/// `fnv1a64(label)`. The state derivation is the engine's (`simulate.ts` uses labels
/// `network` and the node id); the selector keeps two labels on distinct PCG streams.
#[must_use]
pub fn stream(seed: u64, label: &str) -> Pcg32 {
    Pcg32::new(
        fnv1a64(format!("{seed}/{label}").as_bytes()),
        fnv1a64(label.as_bytes()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_reference_check_output_for_seed_42_54() {
        // pcg-c test-high/expected/check-pcg32.out, as pcg32.test.ts asserts.
        let mut rng = Pcg32::new(42, 54);
        let expected = [
            0xa15c_02b7,
            0x7b47_f409,
            0xba1d_3330,
            0x83d2_f293,
            0xbfa4_784b,
            0xcbed_606e,
        ];
        let actual: Vec<u32> = expected.iter().map(|_| rng.next_u32()).collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn matches_the_engine_streams() {
        // The engine's network stream for seed 42: new Pcg32(fnv1a64String('42/network'), 0n).
        let mut network = Pcg32::new(fnv1a64(b"42/network"), 0);
        assert_eq!(network.next_u32(), 0xaf52_4a62);
        assert_eq!(network.next_u32(), 0xe605_927b);
        assert_eq!(network.next_u32(), 0x38d6_c87b);
        assert_eq!(network.next_u32(), 0xabc3_f47a);
        // stream(42, "sched"), pinned on the TypeScript side too (pcg32.test.ts).
        let mut sched = stream(42, "sched");
        assert_eq!(sched.next_u32(), 0xa728_c242);
        assert_eq!(sched.next_u32(), 0x9ad1_8a72);
        assert_eq!(sched.next_u32(), 0x4096_192d);
        assert_eq!(sched.next_u32(), 0xe568_9df8);
    }

    #[test]
    fn streams_are_deterministic_and_distinct() {
        let a: Vec<u32> = (0..8).map(|_| stream(7, "sched").next_u32()).collect();
        let b: Vec<u32> = (0..8).map(|_| stream(7, "sched").next_u32()).collect();
        assert_eq!(a, b);
        let mut s = stream(7, "sched");
        let mut n = stream(7, "net");
        let mut other_seed = stream(8, "sched");
        let (x, y, z): (Vec<u32>, Vec<u32>, Vec<u32>) = (
            (0..8).map(|_| s.next_u32()).collect(),
            (0..8).map(|_| n.next_u32()).collect(),
            (0..8).map(|_| other_seed.next_u32()).collect(),
        );
        assert_ne!(x, y);
        assert_ne!(x, z);
    }

    #[test]
    fn below_and_chance_behave_at_the_edges() {
        let mut rng = Pcg32::new(1, 1);
        assert_eq!(rng.below(1), 0);
        let mut seen = [false; 5];
        for _ in 0..500 {
            seen[usize::try_from(rng.below(5)).unwrap()] = true;
        }
        assert!(seen.iter().all(|&s| s));
        assert!(!rng.chance(0.0));
        assert!(rng.chance(1.0));
        let heads = (0..10_000).filter(|_| rng.chance(0.5)).count();
        assert!((4_500..=5_500).contains(&heads), "{heads}");
        let mut bytes = [0u8; 7];
        rng.fill_bytes(&mut bytes);
        assert_ne!(bytes, [0u8; 7]);
    }
}
