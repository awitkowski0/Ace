//! Anchored fuzzy matcher (IntelliJ-like "minuscule" semantics, simplified).
//!
//! Every matched query character must be one of:
//!  * the first character of a "word" in the text (start, after a non-alphanumeric, camel hump, digit run start),
//!  * directly adjacent to the previously matched character (consecutive run), or
//!  * later in the *same word* as the previously matched character (`ctl` -> `Controller`).
//! The first query character must sit on an anchor. Scattered matches across unrelated words
//! (`audsaf` -> `audio_cache/say_f.aiff`) are therefore rejected.

#[inline]
fn is_anchor(t: &[char], j: usize) -> bool {
    if j == 0 {
        return true;
    }
    let (p, c) = (t[j - 1], t[j]);
    if !p.is_alphanumeric() {
        return true;
    }
    if p.is_lowercase() && c.is_uppercase() {
        return true;
    }
    if p.is_ascii_digit() != c.is_ascii_digit() && c.is_alphanumeric() {
        return true;
    }
    // acronym end: "XMLParser" -> P
    if p.is_uppercase() && c.is_uppercase() && t.get(j + 1).map(|n| n.is_lowercase()).unwrap_or(false) {
        return true;
    }
    false
}

/// Cheap necessary condition: query is a case-insensitive subsequence of text (bytes, ascii fast path).
pub fn subsequence(q: &str, t: &str) -> bool {
    let mut tb = t.bytes();
    'outer: for qc in q.bytes() {
        let ql = qc.to_ascii_lowercase();
        for b in tb.by_ref() {
            if b.to_ascii_lowercase() == ql {
                continue 'outer;
            }
        }
        return false;
    }
    true
}

#[derive(Debug, Clone)]
pub struct Match {
    pub score: i32,
    /// char indices into the text
    pub indices: Vec<u32>,
}

/// Anchored match of `q` against `text`. Returns best-scoring placement.
pub fn anchored(q: &[char], text: &[char]) -> Option<Match> {
    let (m, n) = (q.len(), text.len());
    if m == 0 || m > n {
        return None;
    }
    let anchor: Vec<bool> = (0..n).map(|j| is_anchor(text, j)).collect();
    let mut wstart = vec![0usize; n];
    let mut cur = 0;
    for j in 0..n {
        if anchor[j] {
            cur = j;
        }
        wstart[j] = cur;
    }
    const NEG: i32 = i32::MIN / 2;
    let mut dp = vec![NEG; m * n];
    let mut par = vec![usize::MAX; m * n];
    for i in 0..m {
        let qc = q[i];
        let ql = qc.to_lowercase().next().unwrap_or(qc);
        let q_alnum = qc.is_alphanumeric();
        for j in 0..n {
            let tc = text[j];
            if tc != qc && tc.to_lowercase().next().unwrap_or(tc) != ql {
                continue;
            }
            let case_bonus = if tc == qc { 1 } else { 0 };
            let anch = anchor[j] || !q_alnum;
            let a_bonus = if anchor[j] { 8 } else { 0 };
            if i == 0 {
                if !anch {
                    continue;
                }
                let first = if j == 0 { 10 } else { 0 };
                dp[j] = 1 + a_bonus + case_bonus + first - (j as i32) / 8;
                continue;
            }
            let mut best = NEG;
            let mut from = usize::MAX;
            for k in 0..j {
                let prev = dp[(i - 1) * n + k];
                if prev <= NEG {
                    continue;
                }
                let consecutive = k + 1 == j;
                let same_word = wstart[j] <= k;
                if !(consecutive || anchor[j] || same_word || !q_alnum) {
                    continue;
                }
                let mut s = prev;
                if consecutive {
                    s += 6;
                } else if same_word && !anchor[j] {
                    s -= 1 + (j - k - 1) as i32; // skipping inside a word
                } else {
                    s -= ((j - k - 1) as i32).min(6) / 2; // small gap penalty between words
                }
                if s > best {
                    best = s;
                    from = k;
                }
            }
            if from != usize::MAX {
                dp[i * n + j] = best + 1 + a_bonus + case_bonus;
                par[i * n + j] = from;
            }
        }
    }
    let (mut bj, mut bs) = (usize::MAX, NEG);
    for j in 0..n {
        let v = dp[(m - 1) * n + j];
        if v > bs {
            bs = v;
            bj = j;
        }
    }
    if bj == usize::MAX {
        return None;
    }
    let mut idx = vec![0u32; m];
    let mut j = bj;
    for i in (0..m).rev() {
        idx[i] = j as u32;
        j = par[i * n + j];
    }
    // prefer shorter texts / tight matches
    let score = bs * 4 - (n as i32) / 4;
    Some(Match { score, indices: idx })
}

pub fn anchored_str(q: &str, text: &str) -> Option<Match> {
    if !subsequence(q, text) {
        return None;
    }
    let qc: Vec<char> = q.chars().filter(|c| !c.is_whitespace()).collect();
    let tc: Vec<char> = text.chars().collect();
    anchored(&qc, &tc)
}

/// Path-aware match: `q` may contain `/` separating segments that must match successive path segments.
/// Without a slash only the file name (last segment) is matched. Returned indices are char indices into `rel`.
pub fn match_path(q: &str, rel: &str, name_off_bytes: usize) -> Option<Match> {
    let name = &rel[name_off_bytes..];
    if !q.contains('/') {
        let mut m = anchored_str(q, name)?;
        let off = rel[..name_off_bytes].chars().count() as u32;
        for i in m.indices.iter_mut() {
            *i += off;
        }
        // file-name hits outrank anything path-only
        m.score += 1000;
        return Some(m);
    }
    let qsegs: Vec<&str> = q.split('/').filter(|s| !s.is_empty()).collect();
    if qsegs.is_empty() {
        return None;
    }
    // path segments with char offsets
    let mut segs: Vec<(usize, &str)> = Vec::new();
    let mut off = 0usize;
    for s in rel.split('/') {
        segs.push((off, s));
        off += s.chars().count() + 1;
    }
    let mut cursor = 0usize;
    let mut total = 0;
    let mut indices = Vec::new();
    let last_q = qsegs.len() - 1;
    for (qi, qs) in qsegs.iter().enumerate() {
        let mut found = None;
        if qi == last_q {
            let (o, s) = segs[segs.len() - 1];
            if segs.len() - 1 >= cursor {
                if let Some(m) = anchored_str(qs, s) {
                    found = Some((segs.len() - 1, o, m, 40));
                }
            }
        }
        if found.is_none() {
            for si in cursor..segs.len() {
                let (o, s) = segs[si];
                if let Some(m) = anchored_str(qs, s) {
                    found = Some((si, o, m, 0));
                    break;
                }
            }
        }
        let (si, o, m, bonus) = found?;
        cursor = si + 1;
        total += m.score + bonus;
        indices.extend(m.indices.iter().map(|i| i + o as u32));
    }
    Some(Match { score: total, indices })
}
