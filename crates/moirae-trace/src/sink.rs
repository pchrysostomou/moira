//! Where a [`Writer`](crate::Writer) sends its lines.

use crate::writer::Error;

/// Receives one serialised line at a time, without its newline.
pub trait Sink {
    /// Accepts the next line.
    ///
    /// # Errors
    ///
    /// Whatever the sink cannot accept; [`Verify`] fails on divergence.
    fn line(&mut self, line: &str) -> Result<(), Error>;
}

/// Keeps every line.
#[derive(Debug, Default)]
pub struct Collect {
    /// The lines so far, header first, without newlines.
    pub lines: Vec<String>,
}

impl Collect {
    /// The trace as JSONL: lines joined by LF with a trailing LF, exactly as
    /// `SimulationResult.jsonl`.
    #[must_use]
    pub fn jsonl(&self) -> String {
        let mut out = self.lines.join("\n");
        out.push('\n');
        out
    }
}

impl Sink for Collect {
    fn line(&mut self, line: &str) -> Result<(), Error> {
        self.lines.push(line.to_owned());
        Ok(())
    }
}

/// Compares each line against a recorded trace and fails at the first difference, naming
/// the 1-based line. This is how a replay with the recorded seed proves it still
/// reproduces, and where it stopped doing so.
#[derive(Debug)]
pub struct Verify {
    expected: Vec<String>,
    next: usize,
}

impl Verify {
    /// Verifies against the JSONL text of a recorded trace.
    #[must_use]
    pub fn against(recorded: &str) -> Self {
        let mut expected: Vec<String> = recorded.split('\n').map(str::to_owned).collect();
        if expected.last().is_some_and(String::is_empty) {
            expected.pop();
        }
        Self { expected, next: 0 }
    }

    /// Lines matched so far.
    #[must_use]
    pub fn matched(&self) -> usize {
        self.next
    }

    /// `true` once every recorded line has been reproduced.
    #[must_use]
    pub fn complete(&self) -> bool {
        self.next == self.expected.len()
    }
}

impl Sink for Verify {
    fn line(&mut self, line: &str) -> Result<(), Error> {
        let number = self.next + 1;
        match self.expected.get(self.next) {
            None => Err(Error::LongerThanRecording { line: number }),
            Some(expected) if expected != line => Err(Error::Divergence {
                line: number,
                expected: expected.clone(),
                actual: line.to_owned(),
            }),
            Some(_) => {
                self.next += 1;
                Ok(())
            }
        }
    }
}
