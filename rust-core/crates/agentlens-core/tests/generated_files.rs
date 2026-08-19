//! P5c: src/generatedFiles.ts — the scratch-tree indexer (bounded BFS, mtime-gated listing
//! cache), the referenced-path resolver, and attachGeneratedFiles onto a card.

use agentlens_core::generated_files::{attach_generated_files, index_scratch_tree, resolve_generated_file, scratch_listing_stats};
use serde_json::json;

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-gen-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn scratch_tree_is_indexed_breadth_first_bounded_and_attached_with_referenced_winning() {
    let root = tmp("roots");
    let sid = "dddddddd-1111-2222-3333-444444444444";
    // {root}/claude-<uid>/<slug>/<sid>/{a.txt, sub/b.txt, sub/deeper/c.txt}; a foreign uid dir and
    // another session under the same slug are NOT this session's tree.
    let sess = root.join("claude-501").join("-Users-someone-proj").join(sid);
    std::fs::create_dir_all(sess.join("sub").join("deeper")).unwrap();
    std::fs::write(sess.join("a.txt"), "aaaa").unwrap();
    std::fs::write(sess.join("sub").join("b.txt"), "bbbbb").unwrap();
    std::fs::write(sess.join("sub").join("deeper").join("c.txt"), "").unwrap();
    std::fs::create_dir_all(root.join("not-claude").join("x").join(sid)).unwrap();
    std::fs::write(root.join("not-claude").join("x").join(sid).join("z.txt"), "zz").unwrap();
    std::fs::create_dir_all(root.join("claude-501").join("-Users-someone-proj").join("other-session")).unwrap();
    std::fs::write(root.join("claude-501").join("-Users-someone-proj").join("other-session").join("o.txt"), "o").unwrap();
    let roots = vec![root.clone()];

    let (files, truncated) = index_scratch_tree(sid, Some(&roots), 500);
    assert!(!truncated);
    let paths: Vec<&str> = files.iter().map(|f| f["path"].as_str().unwrap()).collect();
    // Breadth-first: the session dir's own files, then sub/, then sub/deeper/.
    assert_eq!(paths.len(), 3);
    assert!(paths[0].ends_with("/a.txt") && paths[1].ends_with("/b.txt") && paths[2].ends_with("/c.txt"), "{paths:?}");
    assert_eq!(files[0]["sizeBytes"], 4);
    assert_eq!(files[0]["tokenEstimate"], 1, "ceil(4/4)");
    assert_eq!(files[1]["tokenEstimate"], 2, "ceil(5/4)");
    assert_eq!(files[2]["tokenEstimate"], 0);
    assert_eq!(files[0]["origin"], "scratch");
    assert!(files[0].get("missing").is_none());
    assert!(files[0]["mtimeMs"].as_i64().unwrap() > 0);
    // The cap: truncated the moment it is hit, never silent.
    let (files, truncated) = index_scratch_tree(sid, Some(&roots), 2);
    assert_eq!((files.len(), truncated), (2, true));
    // Unknown session / empty id: nothing, no truncation.
    assert_eq!(index_scratch_tree("nope", Some(&roots), 500), (Vec::new(), false));
    assert_eq!(index_scratch_tree("", Some(&roots), 500), (Vec::new(), false));

    // The listing cache: a second identical walk is all hits (no readdir), while an ADDED file
    // bumps its dir's mtime and is listed on the next call.
    let (r0, h0, _) = scratch_listing_stats();
    index_scratch_tree(sid, Some(&roots), 500);
    let (r1, h1, _) = scratch_listing_stats();
    assert_eq!(r1, r0, "no new readdir for an unchanged tree");
    assert!(h1 > h0, "served from the listing cache");
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(sess.join("sub").join("d.txt"), "dd").unwrap();
    let (files, _) = index_scratch_tree(sid, Some(&roots), 500);
    assert_eq!(files.len(), 4, "the new file is discovered (the dir mtime moved)");

    // resolveGeneratedFile: a referenced path that is gone is a missing ref; a scratch one is None;
    // a directory is None for both.
    let gone = format!("{}/gone.md", sess.display());
    assert_eq!(resolve_generated_file(&gone, "referenced"), Some(json!({ "path": gone, "sizeBytes": 0, "mtimeMs": 0, "tokenEstimate": 0, "origin": "referenced", "missing": true })));
    assert_eq!(resolve_generated_file(&gone, "scratch"), None);
    assert_eq!(resolve_generated_file(&sess.to_string_lossy(), "referenced"), None);

    // attachGeneratedFiles: the correlated ref lands on its timeline entry, the uncorrelated one
    // at card level, the scratch index follows, and a referenced path that the walk also finds is
    // NOT duplicated (referenced wins, carrying its spanId).
    let a_txt = sess.join("a.txt").to_string_lossy().into_owned();
    let mut card = json!({ "sessionId": sid, "timeline": [ { "spanId": "s1", "kind": "tool_call" }, { "spanId": "s2", "kind": "tool_call" } ] });
    let harvested = vec![(a_txt.clone(), Some("s1".to_owned())), (gone.clone(), None)];
    attach_generated_files(card.as_object_mut().unwrap(), &harvested, Some(&roots), 500);
    assert_eq!(card["timeline"][0]["generatedFiles"][0]["path"], a_txt);
    assert_eq!(card["timeline"][0]["generatedFiles"][0]["origin"], "referenced");
    assert!(card["timeline"][1].get("generatedFiles").is_none());
    let level: Vec<(&str, &str)> = card["generatedFiles"].as_array().unwrap().iter().map(|f| (f["path"].as_str().unwrap(), f["origin"].as_str().unwrap())).collect();
    assert_eq!(level[0], (gone.as_str(), "referenced"));
    assert_eq!(level.len(), 1 + 3, "the missing ref + b, c, d from the walk (a.txt was referenced — not repeated)");
    assert!(level[1..].iter().all(|(p, o)| *o == "scratch" && !p.ends_with("/a.txt")));
    assert!(card.get("generatedFilesTruncated").is_none());
    // Idempotent: a re-run yields the same card; a tight cap sets the flag.
    let before = card.clone();
    attach_generated_files(card.as_object_mut().unwrap(), &harvested, Some(&roots), 500);
    assert_eq!(card, before);
    attach_generated_files(card.as_object_mut().unwrap(), &harvested, Some(&roots), 1);
    assert_eq!(card["generatedFilesTruncated"], true);
    // No refs at all: the key is ABSENT, never an empty array.
    let mut bare = json!({ "sessionId": "zzzz", "timeline": [] });
    attach_generated_files(bare.as_object_mut().unwrap(), &[], Some(&roots), 500);
    assert_eq!(bare, json!({ "sessionId": "zzzz", "timeline": [] }));
}
