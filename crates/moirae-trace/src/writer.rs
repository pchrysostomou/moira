//! Serialising events in the engine's field order and stamping `seq`.

use std::fmt;

use crate::FORMAT_VERSION;
use crate::event::{Event, Header, NodeId};
use crate::json::{Json, write_int, write_str, write_u64};
use crate::sink::Sink;

/// What can go wrong while writing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// An integer a JavaScript reader would not keep exact.
    UnsafeInteger(i128),
    /// A field that must be a JSON object was not: the name says which.
    NotAnObject(&'static str),
    /// An event was written before the header.
    HeaderFirst,
    /// The header was written twice.
    HeaderTwice,
    /// A [`Verify`](crate::Verify) sink saw a different line than the recording.
    Divergence {
        /// The 1-based line number.
        line: usize,
        /// What the recording has.
        expected: String,
        /// What was written.
        actual: String,
    },
    /// A [`Verify`](crate::Verify) sink received more lines than the recording has.
    LongerThanRecording {
        /// The 1-based line number that has no counterpart.
        line: usize,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::UnsafeInteger(v) => {
                write!(f, "integer {v} is outside the JavaScript-safe range")
            }
            Error::NotAnObject(what) => write!(f, "{what} must be a JSON object"),
            Error::HeaderFirst => f.write_str("the header must be written before any event"),
            Error::HeaderTwice => f.write_str("the header was already written"),
            Error::Divergence {
                line,
                expected,
                actual,
            } => {
                write!(
                    f,
                    "line {line} diverges from the recording\n  recorded: {expected}\n  written:  {actual}"
                )
            }
            Error::LongerThanRecording { line } => {
                write!(f, "line {line} goes past the end of the recording")
            }
        }
    }
}

impl std::error::Error for Error {}

/// Serialises a header and events, stamping each event with the next `seq`, and hands
/// every line to a [`Sink`].
#[derive(Debug)]
pub struct Writer<S: Sink> {
    sink: S,
    seq: u64,
    header_written: bool,
}

impl<S: Sink> Writer<S> {
    /// A writer over `sink`; call [`header`](Self::header) first.
    pub fn new(sink: S) -> Self {
        Self {
            sink,
            seq: 0,
            header_written: false,
        }
    }

    /// The `seq` the next event will carry.
    #[must_use]
    pub fn next_seq(&self) -> u64 {
        self.seq
    }

    /// The sink.
    #[must_use]
    pub fn sink(&self) -> &S {
        &self.sink
    }

    /// Takes the sink back.
    #[must_use]
    pub fn into_sink(self) -> S {
        self.sink
    }

    /// Writes the header line. Must come first, and only once.
    ///
    /// # Errors
    ///
    /// [`Error::HeaderTwice`], an unsafe integer, a non-object `network`, or the sink's error.
    pub fn header(&mut self, header: &Header) -> Result<(), Error> {
        if self.header_written {
            return Err(Error::HeaderTwice);
        }
        let mut line = String::with_capacity(96);
        line.push_str("{\"kind\":\"header\",\"v\":");
        write_int(i64::from(FORMAT_VERSION), &mut line)?;
        line.push_str(",\"seed\":");
        write_u64(header.seed, &mut line)?;
        line.push_str(",\"nodes\":");
        write_u64(u64::from(header.nodes), &mut line)?;
        line.push_str(",\"unit\":");
        write_str(header.unit.as_str(), &mut line);
        if let Some(network) = &header.network {
            require_object(network, "network")?;
            line.push_str(",\"network\":");
            network.write_to(&mut line)?;
        }
        for (key, value) in &header.extra {
            line.push(',');
            write_str(key, &mut line);
            line.push(':');
            value.write_to(&mut line)?;
        }
        line.push('}');
        self.sink.line(&line)?;
        self.header_written = true;
        Ok(())
    }

    /// Writes one event and returns the `seq` it was stamped with.
    ///
    /// # Errors
    ///
    /// [`Error::HeaderFirst`], an unsafe integer, a non-object `msg`, `patch` or `data`,
    /// or the sink's error.
    pub fn emit(&mut self, event: &Event) -> Result<u64, Error> {
        if !self.header_written {
            return Err(Error::HeaderFirst);
        }
        let seq = self.seq;
        let mut line = String::with_capacity(128);
        line.push_str("{\"t\":");
        write_u64(event.t(), &mut line)?;
        line.push_str(",\"seq\":");
        write_u64(seq, &mut line)?;
        line.push_str(",\"kind\":\"");
        match event {
            Event::Init { node, .. } => {
                line.push_str("init\"");
                field_node(&mut line, *node)?;
            }
            Event::Send {
                from,
                to,
                msg_id,
                msg,
                ..
            } => {
                require_object(msg, "msg")?;
                line.push_str("send\",\"from\":");
                write_u64(u64::from(*from), &mut line)?;
                line.push_str(",\"to\":");
                write_u64(u64::from(*to), &mut line)?;
                line.push_str(",\"msgId\":");
                write_u64(*msg_id, &mut line)?;
                line.push_str(",\"msg\":");
                msg.write_to(&mut line)?;
            }
            Event::Deliver { msg_id, dup, .. } => {
                line.push_str("deliver\",\"msgId\":");
                write_u64(*msg_id, &mut line)?;
                if *dup {
                    line.push_str(",\"dup\":true");
                }
            }
            Event::Drop { msg_id, reason, .. } => {
                line.push_str("drop\",\"msgId\":");
                write_u64(*msg_id, &mut line)?;
                line.push_str(",\"reason\":");
                write_str(reason, &mut line);
            }
            Event::State { node, patch, .. } => {
                require_object(patch, "patch")?;
                line.push_str("state\"");
                field_node(&mut line, *node)?;
                line.push_str(",\"patch\":");
                patch.write_to(&mut line)?;
            }
            Event::Timer { node, name, .. } => {
                line.push_str("timer\"");
                field_node(&mut line, *node)?;
                line.push_str(",\"name\":");
                write_str(name, &mut line);
            }
            Event::Log {
                node, event, data, ..
            } => {
                if let Some(data) = data {
                    require_object(data, "data")?;
                }
                line.push_str("log\"");
                field_node(&mut line, *node)?;
                line.push_str(",\"event\":");
                write_str(event, &mut line);
                if let Some(data) = data {
                    line.push_str(",\"data\":");
                    data.write_to(&mut line)?;
                }
            }
            Event::Crash {
                node,
                cause,
                fields,
                ..
            } => {
                line.push_str("fault\",\"fault\":\"crash\"");
                field_node(&mut line, *node)?;
                line.push_str(",\"cause\":");
                write_str(cause.as_str(), &mut line);
                if let Some(fields) = fields {
                    line.push_str(",\"persisted\":");
                    string_array(&fields.persisted, &mut line);
                    line.push_str(",\"lost\":");
                    string_array(&fields.lost, &mut line);
                }
            }
            Event::Restart { node, .. } => {
                line.push_str("fault\",\"fault\":\"restart\"");
                field_node(&mut line, *node)?;
            }
            Event::Partition { groups, .. } => {
                line.push_str("fault\",\"fault\":\"partition\",\"groups\":");
                node_groups(groups, &mut line)?;
            }
            Event::Heal { groups, .. } => {
                line.push_str("fault\",\"fault\":\"heal\",\"groups\":");
                node_groups(groups, &mut line)?;
            }
            Event::Violation {
                invariant, detail, ..
            } => {
                line.push_str("violation\",\"invariant\":");
                write_str(invariant, &mut line);
                line.push_str(",\"detail\":");
                write_str(detail, &mut line);
            }
        }
        line.push('}');
        self.sink.line(&line)?;
        self.seq += 1;
        Ok(seq)
    }
}

fn field_node(line: &mut String, node: NodeId) -> Result<(), Error> {
    line.push_str(",\"node\":");
    write_u64(u64::from(node), line)
}

fn require_object(value: &Json, what: &'static str) -> Result<(), Error> {
    if matches!(value, Json::Object(_)) {
        Ok(())
    } else {
        Err(Error::NotAnObject(what))
    }
}

fn string_array(items: &[String], line: &mut String) {
    line.push('[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            line.push(',');
        }
        write_str(item, line);
    }
    line.push(']');
}

fn node_groups(groups: &[Vec<NodeId>], line: &mut String) -> Result<(), Error> {
    line.push('[');
    for (i, group) in groups.iter().enumerate() {
        if i > 0 {
            line.push(',');
        }
        line.push('[');
        for (j, node) in group.iter().enumerate() {
            if j > 0 {
                line.push(',');
            }
            write_u64(u64::from(*node), line)?;
        }
        line.push(']');
    }
    line.push(']');
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Collect, TimeUnit, Verify};

    fn header() -> Header {
        Header {
            seed: 7,
            nodes: 2,
            unit: TimeUnit::Ms,
            network: None,
            extra: Vec::new(),
        }
    }

    const HEADER_LINE: &str =
        "{\"kind\":\"header\",\"v\":2,\"seed\":7,\"nodes\":2,\"unit\":\"ms\"}";

    #[test]
    fn header_comes_first_and_only_once() {
        let mut w = Writer::new(Collect::default());
        assert_eq!(
            w.emit(&Event::Init { t: 0, node: 1 }),
            Err(Error::HeaderFirst)
        );
        w.header(&header()).unwrap();
        assert_eq!(w.header(&header()), Err(Error::HeaderTwice));
        assert_eq!(w.emit(&Event::Init { t: 0, node: 1 }), Ok(0));
        assert_eq!(w.emit(&Event::Init { t: 0, node: 2 }), Ok(1));
        assert_eq!(w.next_seq(), 2);
        let expected = format!(
            "{HEADER_LINE}\n{{\"t\":0,\"seq\":0,\"kind\":\"init\",\"node\":1}}\n{{\"t\":0,\"seq\":1,\"kind\":\"init\",\"node\":2}}\n"
        );
        assert_eq!(w.into_sink().jsonl(), expected);
    }

    #[test]
    fn objects_are_required_where_the_schema_says_object() {
        let mut w = Writer::new(Collect::default());
        w.header(&header()).unwrap();
        let bad = Json::Array(vec![]);
        assert_eq!(
            w.emit(&Event::Send {
                t: 1,
                from: 1,
                to: 2,
                msg_id: 0,
                msg: bad.clone()
            }),
            Err(Error::NotAnObject("msg"))
        );
        assert_eq!(
            w.emit(&Event::State {
                t: 1,
                node: 1,
                patch: bad.clone()
            }),
            Err(Error::NotAnObject("patch"))
        );
        assert_eq!(
            w.emit(&Event::Log {
                t: 1,
                node: 1,
                event: "x".into(),
                data: Some(bad)
            }),
            Err(Error::NotAnObject("data"))
        );
        assert_eq!(w.next_seq(), 0, "a rejected event consumes no seq");
    }

    #[test]
    fn times_beyond_2_53_are_refused() {
        let mut w = Writer::new(Collect::default());
        w.header(&header()).unwrap();
        let too_big = crate::MAX_SAFE_INTEGER + 1;
        assert_eq!(
            w.emit(&Event::Init {
                t: too_big,
                node: 1
            }),
            Err(Error::UnsafeInteger(i128::from(too_big)))
        );
    }

    #[test]
    fn verify_reports_the_first_divergence_by_line() {
        let recorded = format!(
            "{HEADER_LINE}\n{{\"t\":0,\"seq\":0,\"kind\":\"init\",\"node\":1}}\n{{\"t\":0,\"seq\":1,\"kind\":\"init\",\"node\":2}}\n"
        );
        let mut w = Writer::new(Verify::against(&recorded));
        w.header(&header()).unwrap();
        w.emit(&Event::Init { t: 0, node: 1 }).unwrap();
        let err = w.emit(&Event::Init { t: 5, node: 2 }).unwrap_err();
        assert_eq!(
            err,
            Error::Divergence {
                line: 3,
                expected: "{\"t\":0,\"seq\":1,\"kind\":\"init\",\"node\":2}".into(),
                actual: "{\"t\":5,\"seq\":1,\"kind\":\"init\",\"node\":2}".into(),
            }
        );
        assert!(!w.sink().complete());

        let mut w = Writer::new(Verify::against(&recorded));
        w.header(&header()).unwrap();
        w.emit(&Event::Init { t: 0, node: 1 }).unwrap();
        w.emit(&Event::Init { t: 0, node: 2 }).unwrap();
        assert!(w.sink().complete());
        assert_eq!(
            w.emit(&Event::Init { t: 0, node: 2 }),
            Err(Error::LongerThanRecording { line: 4 })
        );
    }
}
