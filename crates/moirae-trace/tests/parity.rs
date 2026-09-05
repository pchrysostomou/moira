//! Parity with the TypeScript engine (ADR-009): the committed fixtures are what the
//! engine produces (asserted by `examples/test/trace-fixture.test.ts` in the pnpm suite),
//! and this crate must reproduce them byte for byte. The event lists below were
//! transcribed from the fixtures; if a fixture changes, regenerate both sides together.

use moirae_trace::{
    Cause, Collect, CrashFields, Event, Header, Json, TimeUnit, Verify, Writer, trace_hash,
};

fn write(header: &Header, events: &[Event]) -> String {
    let mut w = Writer::new(Collect::default());
    w.header(header).unwrap();
    for e in events {
        w.emit(e).unwrap();
    }
    w.into_sink().jsonl()
}

#[test]
fn reproduces_the_engine_fixture() {
    let expected = include_str!("fixtures/engine.jsonl");
    let header = Header {
        seed: 3,
        nodes: 2,
        unit: TimeUnit::Ms,
        network: Some(Json::obj(vec![
            ("latency", Json::Array(vec![Json::Int(5), Json::Int(5)])),
            ("dropRate", Json::Int(0)),
            ("duplicateRate", Json::Int(1)),
            (
                "partitions",
                Json::Array(vec![Json::obj(vec![
                    (
                        "groups",
                        Json::Array(vec![
                            Json::Array(vec![Json::Int(1)]),
                            Json::Array(vec![Json::Int(2)]),
                        ]),
                    ),
                    ("start", Json::Int(45)),
                    ("end", Json::Int(60)),
                ])]),
            ),
        ])),
        extra: vec![],
    };
    let events = vec![
        Event::Init { t: 0, node: 1 },
        Event::State {
            t: 0,
            node: 1,
            patch: Json::obj(vec![("sent", Json::Int(0)), ("got", Json::Int(0))]),
        },
        Event::Init { t: 0, node: 2 },
        Event::State {
            t: 0,
            node: 2,
            patch: Json::obj(vec![("sent", Json::Int(0)), ("got", Json::Int(0))]),
        },
        Event::Timer {
            t: 10,
            node: 1,
            name: "tick".into(),
        },
        Event::Send {
            t: 10,
            from: 1,
            to: 2,
            msg_id: 0,
            msg: Json::obj(vec![
                ("type", Json::str("ping")),
                ("n", Json::Int(1)),
                ("tag", Json::str("a\"b\\c\n")),
            ]),
        },
        Event::Log {
            t: 10,
            node: 1,
            event: "tick".into(),
            data: Some(Json::obj(vec![("n", Json::Int(1))])),
        },
        Event::State {
            t: 10,
            node: 1,
            patch: Json::obj(vec![("sent", Json::Int(1))]),
        },
        Event::Timer {
            t: 10,
            node: 2,
            name: "tick".into(),
        },
        Event::Send {
            t: 10,
            from: 2,
            to: 1,
            msg_id: 1,
            msg: Json::obj(vec![
                ("type", Json::str("ping")),
                ("n", Json::Int(1)),
                ("tag", Json::str("a\"b\\c\n")),
            ]),
        },
        Event::Log {
            t: 10,
            node: 2,
            event: "tick".into(),
            data: Some(Json::obj(vec![("n", Json::Int(1))])),
        },
        Event::State {
            t: 10,
            node: 2,
            patch: Json::obj(vec![("sent", Json::Int(1))]),
        },
        Event::Deliver {
            t: 15,
            msg_id: 0,
            dup: false,
        },
        Event::Send {
            t: 15,
            from: 2,
            to: 1,
            msg_id: 2,
            msg: Json::obj(vec![("type", Json::str("pong"))]),
        },
        Event::State {
            t: 15,
            node: 2,
            patch: Json::obj(vec![("got", Json::Int(1))]),
        },
        Event::Deliver {
            t: 15,
            msg_id: 0,
            dup: true,
        },
        Event::Send {
            t: 15,
            from: 2,
            to: 1,
            msg_id: 3,
            msg: Json::obj(vec![("type", Json::str("pong"))]),
        },
        Event::State {
            t: 15,
            node: 2,
            patch: Json::obj(vec![("got", Json::Int(2))]),
        },
        Event::Deliver {
            t: 15,
            msg_id: 1,
            dup: false,
        },
        Event::Send {
            t: 15,
            from: 1,
            to: 2,
            msg_id: 4,
            msg: Json::obj(vec![("type", Json::str("pong"))]),
        },
        Event::State {
            t: 15,
            node: 1,
            patch: Json::obj(vec![("got", Json::Int(1))]),
        },
        Event::Deliver {
            t: 15,
            msg_id: 1,
            dup: true,
        },
        Event::Send {
            t: 15,
            from: 1,
            to: 2,
            msg_id: 5,
            msg: Json::obj(vec![("type", Json::str("pong"))]),
        },
        Event::State {
            t: 15,
            node: 1,
            patch: Json::obj(vec![("got", Json::Int(2))]),
        },
        Event::Deliver {
            t: 20,
            msg_id: 2,
            dup: false,
        },
        Event::State {
            t: 20,
            node: 1,
            patch: Json::obj(vec![("got", Json::Int(3))]),
        },
        Event::Deliver {
            t: 20,
            msg_id: 2,
            dup: true,
        },
        Event::State {
            t: 20,
            node: 1,
            patch: Json::obj(vec![("got", Json::Int(4))]),
        },
        Event::Deliver {
            t: 20,
            msg_id: 3,
            dup: false,
        },
        Event::State {
            t: 20,
            node: 1,
            patch: Json::obj(vec![("got", Json::Int(5))]),
        },
        Event::Deliver {
            t: 20,
            msg_id: 3,
            dup: true,
        },
        Event::State {
            t: 20,
            node: 1,
            patch: Json::obj(vec![("got", Json::Int(6))]),
        },
        Event::Deliver {
            t: 20,
            msg_id: 4,
            dup: false,
        },
        Event::State {
            t: 20,
            node: 2,
            patch: Json::obj(vec![("got", Json::Int(3))]),
        },
        Event::Deliver {
            t: 20,
            msg_id: 4,
            dup: true,
        },
        Event::State {
            t: 20,
            node: 2,
            patch: Json::obj(vec![("got", Json::Int(4))]),
        },
        Event::Deliver {
            t: 20,
            msg_id: 5,
            dup: false,
        },
        Event::State {
            t: 20,
            node: 2,
            patch: Json::obj(vec![("got", Json::Int(5))]),
        },
        Event::Deliver {
            t: 20,
            msg_id: 5,
            dup: true,
        },
        Event::State {
            t: 20,
            node: 2,
            patch: Json::obj(vec![("got", Json::Int(6))]),
        },
        Event::Crash {
            t: 25,
            node: 2,
            cause: Cause::Schedule,
            fields: Some(CrashFields {
                persisted: vec!["sent".into()],
                lost: vec!["got".into()],
            }),
        },
        Event::Timer {
            t: 30,
            node: 1,
            name: "tick".into(),
        },
        Event::Send {
            t: 30,
            from: 1,
            to: 2,
            msg_id: 6,
            msg: Json::obj(vec![
                ("type", Json::str("ping")),
                ("n", Json::Int(2)),
                ("tag", Json::str("a\"b\\c\n")),
            ]),
        },
        Event::Log {
            t: 30,
            node: 1,
            event: "tick".into(),
            data: Some(Json::obj(vec![("n", Json::Int(2))])),
        },
        Event::State {
            t: 30,
            node: 1,
            patch: Json::obj(vec![("sent", Json::Int(2))]),
        },
        Event::Drop {
            t: 35,
            msg_id: 6,
            reason: "crashed".into(),
        },
        Event::Drop {
            t: 35,
            msg_id: 6,
            reason: "crashed".into(),
        },
        Event::Partition {
            t: 45,
            groups: vec![vec![1], vec![2]],
        },
        Event::Timer {
            t: 50,
            node: 1,
            name: "tick".into(),
        },
        Event::Send {
            t: 50,
            from: 1,
            to: 2,
            msg_id: 7,
            msg: Json::obj(vec![
                ("type", Json::str("ping")),
                ("n", Json::Int(3)),
                ("tag", Json::str("a\"b\\c\n")),
            ]),
        },
        Event::Drop {
            t: 50,
            msg_id: 7,
            reason: "partition".into(),
        },
        Event::Log {
            t: 50,
            node: 1,
            event: "tick".into(),
            data: Some(Json::obj(vec![("n", Json::Int(3))])),
        },
        Event::State {
            t: 50,
            node: 1,
            patch: Json::obj(vec![("sent", Json::Int(3))]),
        },
        Event::Heal {
            t: 60,
            groups: vec![vec![1], vec![2]],
        },
        Event::Restart { t: 70, node: 2 },
        Event::State {
            t: 70,
            node: 2,
            patch: Json::obj(vec![("sent", Json::Int(1)), ("got", Json::Int(0))]),
        },
        Event::Timer {
            t: 70,
            node: 1,
            name: "tick".into(),
        },
        Event::Send {
            t: 70,
            from: 1,
            to: 2,
            msg_id: 8,
            msg: Json::obj(vec![
                ("type", Json::str("ping")),
                ("n", Json::Int(4)),
                ("tag", Json::str("a\"b\\c\n")),
            ]),
        },
        Event::Log {
            t: 70,
            node: 1,
            event: "tick".into(),
            data: Some(Json::obj(vec![("n", Json::Int(4))])),
        },
        Event::State {
            t: 70,
            node: 1,
            patch: Json::obj(vec![("sent", Json::Int(4))]),
        },
        Event::Deliver {
            t: 75,
            msg_id: 8,
            dup: false,
        },
        Event::Send {
            t: 75,
            from: 2,
            to: 1,
            msg_id: 9,
            msg: Json::obj(vec![("type", Json::str("pong"))]),
        },
        Event::State {
            t: 75,
            node: 2,
            patch: Json::obj(vec![("got", Json::Int(1))]),
        },
        Event::Deliver {
            t: 75,
            msg_id: 8,
            dup: true,
        },
        Event::Send {
            t: 75,
            from: 2,
            to: 1,
            msg_id: 10,
            msg: Json::obj(vec![("type", Json::str("pong"))]),
        },
        Event::State {
            t: 75,
            node: 2,
            patch: Json::obj(vec![("got", Json::Int(2))]),
        },
        Event::Timer {
            t: 80,
            node: 2,
            name: "tick".into(),
        },
        Event::Send {
            t: 80,
            from: 2,
            to: 1,
            msg_id: 11,
            msg: Json::obj(vec![
                ("type", Json::str("ping")),
                ("n", Json::Int(2)),
                ("tag", Json::str("a\"b\\c\n")),
            ]),
        },
        Event::Log {
            t: 80,
            node: 2,
            event: "tick".into(),
            data: Some(Json::obj(vec![("n", Json::Int(2))])),
        },
        Event::State {
            t: 80,
            node: 2,
            patch: Json::obj(vec![("sent", Json::Int(2))]),
        },
        Event::Deliver {
            t: 80,
            msg_id: 9,
            dup: false,
        },
        Event::State {
            t: 80,
            node: 1,
            patch: Json::obj(vec![("got", Json::Int(7))]),
        },
        Event::Deliver {
            t: 80,
            msg_id: 9,
            dup: true,
        },
        Event::State {
            t: 80,
            node: 1,
            patch: Json::obj(vec![("got", Json::Int(8))]),
        },
        Event::Deliver {
            t: 80,
            msg_id: 10,
            dup: false,
        },
        Event::State {
            t: 80,
            node: 1,
            patch: Json::obj(vec![("got", Json::Int(9))]),
        },
        Event::Deliver {
            t: 80,
            msg_id: 10,
            dup: true,
        },
        Event::State {
            t: 80,
            node: 1,
            patch: Json::obj(vec![("got", Json::Int(10))]),
        },
        Event::Deliver {
            t: 85,
            msg_id: 11,
            dup: false,
        },
        Event::Send {
            t: 85,
            from: 1,
            to: 2,
            msg_id: 12,
            msg: Json::obj(vec![("type", Json::str("pong"))]),
        },
        Event::State {
            t: 85,
            node: 1,
            patch: Json::obj(vec![("got", Json::Int(11))]),
        },
        Event::Deliver {
            t: 85,
            msg_id: 11,
            dup: true,
        },
        Event::Send {
            t: 85,
            from: 1,
            to: 2,
            msg_id: 13,
            msg: Json::obj(vec![("type", Json::str("pong"))]),
        },
        Event::State {
            t: 85,
            node: 1,
            patch: Json::obj(vec![("got", Json::Int(12))]),
        },
        Event::Deliver {
            t: 90,
            msg_id: 12,
            dup: false,
        },
        Event::State {
            t: 90,
            node: 2,
            patch: Json::obj(vec![("got", Json::Int(3))]),
        },
        Event::Deliver {
            t: 90,
            msg_id: 12,
            dup: true,
        },
        Event::State {
            t: 90,
            node: 2,
            patch: Json::obj(vec![("got", Json::Int(4))]),
        },
        Event::Deliver {
            t: 90,
            msg_id: 13,
            dup: false,
        },
        Event::State {
            t: 90,
            node: 2,
            patch: Json::obj(vec![("got", Json::Int(5))]),
        },
        Event::Deliver {
            t: 90,
            msg_id: 13,
            dup: true,
        },
        Event::State {
            t: 90,
            node: 2,
            patch: Json::obj(vec![("got", Json::Int(6))]),
        },
        Event::Timer {
            t: 100,
            node: 2,
            name: "tick".into(),
        },
        Event::Send {
            t: 100,
            from: 2,
            to: 1,
            msg_id: 14,
            msg: Json::obj(vec![
                ("type", Json::str("ping")),
                ("n", Json::Int(3)),
                ("tag", Json::str("a\"b\\c\n")),
            ]),
        },
        Event::Log {
            t: 100,
            node: 2,
            event: "tick".into(),
            data: Some(Json::obj(vec![("n", Json::Int(3))])),
        },
        Event::State {
            t: 100,
            node: 2,
            patch: Json::obj(vec![("sent", Json::Int(3))]),
        },
        Event::Violation {
            t: 100,
            invariant: "stopAt100".into(),
            detail: "ran long enough".into(),
        },
    ];
    assert_eq!(write(&header, &events), expected);
    // The recorded file is also what Verify expects, line for line.
    let mut w = Writer::new(Verify::against(expected));
    w.header(&header).unwrap();
    for e in &events {
        w.emit(e).unwrap();
    }
    assert!(w.sink().complete());
    assert_eq!(trace_hash(&write(&header, &events)), trace_hash(expected));
}

#[test]
fn reproduces_the_v2_extras_fixture() {
    let expected = include_str!("fixtures/v2-extras.jsonl");
    let header = Header {
        seed: 9007199254740991,
        nodes: 3,
        unit: TimeUnit::Ns,
        network: None,
        extra: vec![(
            "ananke".into(),
            Json::obj(vec![
                ("version", Json::str("0.0.1")),
                (
                    "clocks",
                    Json::Array(vec![Json::obj(vec![
                        ("node", Json::Int(1)),
                        ("skew", Json::Int(-5000000)),
                        ("drift", Json::Int(250)),
                    ])]),
                ),
            ]),
        )],
    };
    let events = vec![
        Event::Init { t: 0, node: 1 },
        Event::Send {
            t: 1500000000,
            from: 1,
            to: 2,
            msg_id: 0,
            msg: Json::obj(vec![
                ("type", Json::str("ping")),
                (
                    "text",
                    Json::str("quote\" back\\ nl\n tab\t ctl \u{e9} \u{1f600}"),
                ),
            ]),
        },
        Event::Drop {
            t: 1500000000,
            msg_id: 0,
            reason: "queue-full".into(),
        },
        Event::Deliver {
            t: 1500000001,
            msg_id: 0,
            dup: true,
        },
        Event::Log {
            t: 1500000002,
            node: 2,
            event: "ananke.task.polled".into(),
            data: Some(Json::obj(vec![
                ("task", Json::Int(7)),
                ("name", Json::str("echo")),
                (
                    "nested",
                    Json::obj(vec![
                        ("ok", Json::Bool(true)),
                        ("none", Json::Null),
                        ("list", Json::Array(vec![Json::Int(1), Json::Int(-2)])),
                    ]),
                ),
            ])),
        },
        Event::Log {
            t: 1500000003,
            node: 2,
            event: "ananke.time.advanced".into(),
            data: None,
        },
        Event::Crash {
            t: 1500000004,
            node: 3,
            cause: Cause::Schedule,
            fields: None,
        },
        Event::Restart {
            t: 1500000005,
            node: 3,
        },
        Event::Timer {
            t: 1500000006,
            node: 1,
            name: "election".into(),
        },
        Event::Violation {
            t: 1500000007,
            invariant: "electionSafety".into(),
            detail: "two leaders in term 3".into(),
        },
        // SPEC §5: integers past 2^53 travel as strings, in data and as `t`.
        Event::Log {
            t: 1500000008,
            node: 2,
            event: "ananke.wal.recovered".into(),
            data: Some(Json::obj(vec![
                ("records", Json::Int(12)),
                (
                    "stop",
                    Json::obj(vec![
                        ("segment", Json::Int(3)),
                        ("offset", Json::Int(40)),
                        ("reason", Json::str("gap")),
                        ("expected", Json::Int(13)),
                        ("found", Json::Int(18_014_398_509_482_243)),
                    ]),
                ),
            ])),
        },
        Event::Timer {
            t: 9_007_199_254_740_992,
            node: 1,
            name: "late".into(),
        },
    ];
    assert_eq!(write(&header, &events), expected);
    // The recorded file is also what Verify expects, line for line.
    let mut w = Writer::new(Verify::against(expected));
    w.header(&header).unwrap();
    for e in &events {
        w.emit(e).unwrap();
    }
    assert!(w.sink().complete());
    assert_eq!(trace_hash(&write(&header, &events)), trace_hash(expected));
}
