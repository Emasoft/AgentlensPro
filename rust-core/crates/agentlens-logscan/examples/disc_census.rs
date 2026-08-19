//! Census of what discovery finds on THIS machine — a parity aid, not a test.
fn main() {
    let env = agentlens_logscan::discovery::Env::from_process();
    let all = agentlens_logscan::discovery::discover_all(&env);
    let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
    for f in &all { *counts.entry(format!("{:?}", f.source)).or_default() += 1; }
    println!("{counts:?}");
}
