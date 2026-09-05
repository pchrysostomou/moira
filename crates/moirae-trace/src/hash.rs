//! FNV-1a 64 over bytes, the hash moirae pins traces with (`hash.ts`).

const FNV64_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV64_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a 64 over `bytes`.
#[must_use]
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(FNV64_OFFSET, |h, &b| {
        (h ^ u64::from(b)).wrapping_mul(FNV64_PRIME)
    })
}

/// Sixteen lowercase hex digits, zero-padded, as `hex64` in `hash.ts`.
#[must_use]
pub fn hex64(v: u64) -> String {
    format!("{v:016x}")
}

/// The hash moirae pins in CI: FNV-1a 64 over the exact bytes of the JSONL text.
#[must_use]
pub fn trace_hash(jsonl: &str) -> String {
    hex64(fnv1a64(jsonl.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_engine_vectors() {
        // The same vectors as packages/core/test/hash.test.ts.
        assert_eq!(hex64(fnv1a64(b"")), "cbf29ce484222325");
        assert_eq!(hex64(fnv1a64(b"a")), "af63dc4c8601ec8c");
        assert_eq!(hex64(fnv1a64(b"foobar")), "85944171f73967e8");
        assert_eq!(hex64(fnv1a64(b"hello world")), "779a65e7023cd2e7");
        assert_eq!(hex64(1), "0000000000000001");
    }

    #[test]
    fn matches_the_engine_seed_derivation_strings() {
        // fnv1a64String(`${seed}/${label}`) in simulate.ts, for seed 42.
        assert_eq!(hex64(fnv1a64(b"42/network")), "bd64b98915c00fba");
        assert_eq!(hex64(fnv1a64(b"42/1")), "315726d88908ee6f");
    }
}
