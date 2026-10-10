//! Perf check against ~/thematic-kyf:  cargo test --release search::bench -- --nocapture
use super::*;
use std::time::Instant;

fn root() -> Option<String> {
    let p = dirs::home_dir()?.join("thematic-kyf");
    p.exists().then(|| p.to_string_lossy().into_owned())
}

#[test]
fn camel_hump_and_suffix() {
    let ix = index::Index {
        root: "/p".into(), host: "local".into(), local: true,
        files: std::sync::RwLock::new(
            ["scripts/player/PlayerController.gd", "scripts/enemy/PlayerCollider.gd", "README.md"].iter().map(|s| index::Entry::new(s.to_string())).collect()),
        built: Instant::now(), refreshing: Default::default(), gi: ignore::gitignore::Gitignore::empty(), sym: Default::default(),
    };
    let r = index::query_files(&ix, "PlCo", 10, &[]);
    assert!(r.hits.iter().any(|h| h.name == "PlayerController.gd"));
    let r = index::query_files(&ix, "scr/pl/ctl", 10, &[]);
    assert_eq!(r.hits.first().map(|h| h.name.as_str()), Some("PlayerController.gd"));
    let r = index::query_files(&ix, "readme:42", 10, &[]);
    assert_eq!(r.line, Some(42));
    assert_eq!(r.hits[0].name, "README.md");
}

fn names(files: &[&str], q: &str) -> Vec<String> {
    let ix = index::Index {
        root: "/p".into(), host: "local".into(), local: true,
        files: std::sync::RwLock::new(files.iter().map(|s| index::Entry::new(s.to_string())).collect()),
        built: Instant::now(), refreshing: Default::default(), gi: ignore::gitignore::Gitignore::empty(), sym: Default::default(),
    };
    index::query_files(&ix, q, 20, &[]).hits.into_iter().map(|h| h.rel).collect()
}

#[test]
fn anchored_rejects_scattered() {
    let files = ["tools/audio_cache/say_f3a9c1.aiff", "tools/audio_cache/say_fox.aiff", "audio/save_file.gd", "scripts/AudioSafe.gd", "scripts/player/PlayerController.gd"];
    // scattered letters across unrelated words: dropped
    let r = names(&files, "audsaf");
    assert!(!r.iter().any(|p| p.starts_with("tools/")), "{r:?}");
    assert!(r.contains(&"scripts/AudioSafe.gd".to_string()), "camel humps Aud+Saf: {r:?}");
    assert!(names(&files, "xyz").is_empty());
    assert!(names(&files, "ayr").is_empty(), "mid-word start");
    assert!(names(&files, "layer").is_empty());
    assert!(names(&files, "tlr").is_empty());
    assert_eq!(names(&files, "scr/pl/ctl"), vec!["scripts/player/PlayerController.gd"]);
    assert_eq!(names(&files, "PlCo"), vec!["scripts/player/PlayerController.gd"]);
    assert_eq!(names(&files, "playercontroller:42"), vec!["scripts/player/PlayerController.gd"]);
    assert_eq!(names(&files, "AudSaf")[0], "scripts/AudioSafe.gd");
}

#[test]
fn matcher_indices_are_char_offsets() {
    let m = fuzzy::match_path("scr/pl/ctl", "scripts/player/PlayerController.gd", 15).unwrap();
    assert_eq!(&m.indices[..3], &[0, 1, 2]);
    assert_eq!(m.indices[3], 8);
}

#[test]
fn bench_thematic() {
    let Some(root) = root() else { println!("~/thematic-kyf missing; skipped"); return };
    let loc = Location { host: "local".into(), path: root.clone() };
    let t = Instant::now();
    let ix = index::get(&loc).unwrap();
    println!("[bench] index build: {} files in {:.1} ms (cold-ish)", ix.count(), t.elapsed().as_secs_f64() * 1000.0);
    let t = Instant::now();
    index::drop_index(&loc);
    let ix = index::get(&loc).unwrap();
    println!("[bench] index rebuild (warm fs cache): {} files in {:.1} ms", ix.count(), t.elapsed().as_secs_f64() * 1000.0);

    for q in ["pl", "PlCo", "player", "scr/pl/ctl", "main.gd", "x", "audsaf"] {
        let mut best = f64::MAX;
        let mut n = 0;
        for _ in 0..5 {
            let r = index::query_files(&ix, q, 60, &[]);
            best = best.min(r.elapsed_ms);
            n = r.total;
        }
        println!("[bench] file query {q:?}: best {best:.2} ms ({n} matches)");
        assert!(best < 100.0);
    }

    let t = Instant::now();
    let (_h, _) = symbols::query(&ix, "ready", false, 60).unwrap();
    println!("[bench] symbols first query (builds symbol cache): {:.1} ms", t.elapsed().as_secs_f64() * 1000.0);
    let nsym: usize = ix.sym.lock().unwrap().map.values().map(|v| v.len()).sum();
    let (h, ms) = symbols::query(&ix, "ready", false, 60).unwrap();
    println!("[bench] symbols warm query: {ms:.2} ms ({} hits, {nsym} symbols cached)", h.len());
    assert!(ms < 100.0);

    for (q, mask, regex, cs) in [("func", "", false, false), ("signal", "*.gd", false, false), ("func \\w+_ready", "*.gd", true, true), ("zzzqqqnotfound", "", false, false)] {
        let o = text::TextOpts { query: q.into(), case_sensitive: cs, words: false, regex, mask: mask.into(), scope: None, max_results: Some(5000) };
        let mut best = f64::MAX;
        let mut first = f64::INFINITY;
        let mut total = 0;
        for _ in 0..3 {
            let t = Instant::now();
            let first_at = Mutex::new(None::<f64>);
            let cancel = AtomicBool::new(false);
            let cb = |b: Batch| {
                if !b.matches.is_empty() {
                    first_at.lock().unwrap().get_or_insert(t.elapsed().as_secs_f64() * 1000.0);
                }
            };
            total = text::search_local(&root, &o, 1.0, &cancel, &cb);
            let fa = *first_at.lock().unwrap();
            best = best.min(t.elapsed().as_secs_f64() * 1000.0);
            if let Some(f) = fa { first = first.min(f); }
        }
        println!("[bench] find in files {q:?} mask={mask:?}: total {best:.1} ms, first batch {} ms, {total} matches", if first.is_finite() { format!("{first:.1}") } else { "-".into() });
    }
}
