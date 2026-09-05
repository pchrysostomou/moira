//! An ordered JSON value serialised exactly as `JSON.stringify` would.

use std::fmt::Write as _;

use crate::writer::Error;

/// The largest integer a JavaScript reader keeps exact: 2^53 - 1.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A JSON value whose object keys keep their insertion order, because field order is part
/// of the byte format. There are no floats on purpose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Json {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// An integer. Within plus or minus [`MAX_SAFE_INTEGER`] it is written as a number;
    /// outside, as its decimal digits in a string (SPEC §5).
    Int(i64),
    /// A string, escaped the way `JSON.stringify` escapes.
    Str(String),
    /// An array.
    Array(Vec<Json>),
    /// An object in insertion order.
    Object(Vec<(String, Json)>),
}

impl Json {
    /// An object from `(key, value)` pairs, in the order given.
    #[must_use]
    pub fn obj(fields: Vec<(&str, Json)>) -> Json {
        Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }

    /// A string value.
    #[must_use]
    pub fn str(s: &str) -> Json {
        Json::Str(s.to_owned())
    }

    /// An integer value from anything that converts to `i64`.
    #[must_use]
    pub fn int(v: impl Into<i64>) -> Json {
        Json::Int(v.into())
    }

    /// Serialises onto `out` without any whitespace.
    ///
    /// # Errors
    ///
    /// The sink's error; integers never fail (SPEC §5: outside plus or minus
    /// [`MAX_SAFE_INTEGER`] they are written as strings).
    pub fn write_to(&self, out: &mut String) -> Result<(), Error> {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Int(v) => write_int(*v, out)?,
            Json::Str(s) => write_str(s, out),
            Json::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write_to(out)?;
                }
                out.push(']');
            }
            Json::Object(fields) => {
                out.push('{');
                for (i, (key, value)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_str(key, out);
                    out.push(':');
                    value.write_to(out)?;
                }
                out.push('}');
            }
        }
        Ok(())
    }

    /// The serialised text.
    ///
    /// # Errors
    ///
    /// As [`write_to`](Self::write_to).
    pub fn to_json(&self) -> Result<String, Error> {
        let mut out = String::new();
        self.write_to(&mut out)?;
        Ok(out)
    }
}

/// SPEC §5: an integer a JavaScript reader would not keep exact is written as its
/// decimal digits in a string, so a 64-bit value survives the trip and a reader that
/// expects an integer there reads the string as one.
pub(crate) fn write_int(v: i64, out: &mut String) -> Result<(), Error> {
    let safe = i64::try_from(MAX_SAFE_INTEGER).expect("2^53 fits i64");
    if v > safe || v < -safe {
        out.push('"');
    }
    write!(out, "{v}").expect("writing to a String cannot fail");
    if v > safe || v < -safe {
        out.push('"');
    }
    Ok(())
}

/// See [`write_int`].
pub(crate) fn write_u64(v: u64, out: &mut String) -> Result<(), Error> {
    if v > MAX_SAFE_INTEGER {
        out.push('"');
    }
    write!(out, "{v}").expect("writing to a String cannot fail");
    if v > MAX_SAFE_INTEGER {
        out.push('"');
    }
    Ok(())
}

/// `JSON.stringify` string escaping: the two-character escapes for `"`, `\`, backspace,
/// form feed, newline, carriage return and tab; `\u00xx` in lowercase hex for the other
/// control characters; everything else, including non-ASCII, verbatim.
pub(crate) fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => write!(out, "\\u{:04x}", c as u32).expect("String write"),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(j: &Json) -> String {
        j.to_json().unwrap()
    }

    #[test]
    fn escapes_like_json_stringify() {
        assert_eq!(text(&Json::str("plain")), "\"plain\"");
        assert_eq!(
            text(&Json::str("quote\" back\\slash")),
            "\"quote\\\" back\\\\slash\""
        );
        assert_eq!(text(&Json::str("\u{8}\u{c}\n\r\t")), "\"\\b\\f\\n\\r\\t\"");
        assert_eq!(text(&Json::str("\u{1}\u{1f}")), "\"\\u0001\\u001f\"");
        // DEL, e-acute, an emoji and LINE SEPARATOR all pass through, as in JSON.stringify.
        let raw = "\u{7f} \u{e9} \u{1F600} \u{2028}";
        assert_eq!(text(&Json::str(raw)), format!("\"{raw}\""));
    }

    #[test]
    fn nested_values_keep_order_and_use_no_whitespace() {
        let j = Json::obj(vec![
            ("b", Json::int(1)),
            (
                "a",
                Json::Array(vec![Json::Null, Json::Bool(true), Json::obj(vec![])]),
            ),
            ("n", Json::int(-7)),
        ]);
        assert_eq!(text(&j), "{\"b\":1,\"a\":[null,true,{}],\"n\":-7}");
    }

    #[test]
    fn integers_beyond_2_53_are_written_as_strings() {
        let safe = i64::try_from(MAX_SAFE_INTEGER).unwrap();
        assert_eq!(text(&Json::Int(safe)), "9007199254740991");
        assert_eq!(text(&Json::Int(-safe)), "-9007199254740991");
        assert_eq!(text(&Json::Int(safe + 1)), "\"9007199254740992\"");
        assert_eq!(text(&Json::Int(-safe - 1)), "\"-9007199254740992\"");
        assert_eq!(text(&Json::Int(i64::MAX)), "\"9223372036854775807\"");
    }
}
