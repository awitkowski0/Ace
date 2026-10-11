//! Godot 4 binary Variant codec (`encode_variant` / `decode_variant`) as used by the remote debugger wire protocol, mapped to JSON.
//!
//! JSON mapping (decode): nil -> null, bool, int -> number (or {"$":"int","v":"<i64>"} beyond 2^53), float -> number
//! (non-finite -> {"$":"float","v":"nan|inf|-inf"}), String -> string, Array -> array, everything else is a tagged object
//! `{"$":"<Type>", "v": ...}`: Vector2/3/4/Rect2/Transform/Basis/Color/Plane/Quaternion/AABB/Projection (float lists), the *i variants
//! (int lists), StringName, NodePath ({"v": "/root/Main"}), RID, Dictionary ({"v": [[k, v], ...]}), Packed*Array ({"v": [...], "n": len};
//! bytes only {"n": len}), Object ({"id": "<u64>"} for objects sent as id, or {"class", "props": [[k, v], ...]}).
use serde_json::{json, Value};

pub type R<T> = Result<T, String>;

struct Rd<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Rd<'a> {
    fn need(&self, n: usize) -> R<()> {
        if self.p + n > self.b.len() { Err("variant: truncated".into()) } else { Ok(()) }
    }
    fn u32(&mut self) -> R<u32> {
        self.need(4)?;
        let v = u32::from_le_bytes(self.b[self.p..self.p + 4].try_into().unwrap());
        self.p += 4;
        Ok(v)
    }
    fn i32(&mut self) -> R<i32> {
        Ok(self.u32()? as i32)
    }
    fn i64(&mut self) -> R<i64> {
        self.need(8)?;
        let v = i64::from_le_bytes(self.b[self.p..self.p + 8].try_into().unwrap());
        self.p += 8;
        Ok(v)
    }
    fn u64(&mut self) -> R<u64> {
        Ok(self.i64()? as u64)
    }
    fn f32(&mut self) -> R<f64> {
        self.need(4)?;
        let v = f32::from_le_bytes(self.b[self.p..self.p + 4].try_into().unwrap());
        self.p += 4;
        Ok(v as f64)
    }
    fn f64(&mut self) -> R<f64> {
        self.need(8)?;
        let v = f64::from_le_bytes(self.b[self.p..self.p + 8].try_into().unwrap());
        self.p += 8;
        Ok(v)
    }
    fn string(&mut self) -> R<String> {
        let n = self.u32()? as usize;
        self.need(n)?;
        let s = String::from_utf8_lossy(&self.b[self.p..self.p + n]).into_owned();
        self.p += n + (4 - n % 4) % 4;
        Ok(s)
    }
}

fn num(f: f64) -> Value {
    if f.is_finite() { json!(f) } else { json!({"$":"float","v": if f.is_nan() { "nan" } else if f > 0.0 { "inf" } else { "-inf" }}) }
}
fn tag(t: &str, v: Value) -> Value {
    json!({"$": t, "v": v})
}
fn floats(r: &mut Rd, n: usize) -> R<Value> {
    // real_t is single precision in the official builds
    let mut v = Vec::with_capacity(n);
    for _ in 0..n {
        v.push(num(r.f32()?));
    }
    Ok(Value::Array(v))
}
fn ints(r: &mut Rd, n: usize) -> R<Value> {
    let mut v = Vec::with_capacity(n);
    for _ in 0..n {
        v.push(json!(r.i32()?));
    }
    Ok(Value::Array(v))
}

const PACKED_CAP: usize = 4000;

fn container_hint(r: &mut Rd, kind: u32) -> R<()> {
    match kind {
        1 => {
            r.u32()?;
        }
        2 => {
            r.string()?;
        }
        3 => {
            r.string()?;
            // script: encoded as a Variant (usually a string path or null)
            decode_one(r)?;
        }
        _ => {}
    }
    Ok(())
}

fn decode_one(r: &mut Rd) -> R<Value> {
    let hdr = r.u32()?;
    let t = hdr & 0xff;
    let f = hdr >> 16;
    Ok(match t {
        0 => Value::Null,
        1 => json!(r.u32()? != 0),
        2 => {
            let v = if f & 1 != 0 { r.i64()? } else { r.i32()? as i64 };
            if v.abs() > (1 << 53) { json!({"$":"int","v": v.to_string()}) } else { json!(v) }
        }
        3 => num(if f & 1 != 0 { r.f64()? } else { r.f32()? }),
        4 => Value::String(r.string()?),
        5 => tag("Vector2", floats(r, 2)?),
        6 => tag("Vector2i", ints(r, 2)?),
        7 => tag("Rect2", floats(r, 4)?),
        8 => tag("Rect2i", ints(r, 4)?),
        9 => tag("Vector3", floats(r, 3)?),
        10 => tag("Vector3i", ints(r, 3)?),
        11 => tag("Transform2D", floats(r, 6)?),
        12 => tag("Vector4", floats(r, 4)?),
        13 => tag("Vector4i", ints(r, 4)?),
        14 => tag("Plane", floats(r, 4)?),
        15 => tag("Quaternion", floats(r, 4)?),
        16 => tag("AABB", floats(r, 6)?),
        17 => tag("Basis", floats(r, 9)?),
        18 => tag("Transform3D", floats(r, 12)?),
        19 => tag("Projection", floats(r, 16)?),
        20 => tag("Color", floats(r, 4)?),
        21 => tag("StringName", Value::String(r.string()?)),
        22 => {
            let n = r.u32()?;
            if n & 0x8000_0000 != 0 {
                let names = n & 0x7fff_ffff;
                let sub = r.u32()?;
                let fl = r.u32()?;
                let mut parts = Vec::new();
                for _ in 0..(names + sub) {
                    parts.push(r.string()?);
                }
                let names_s = parts[..names as usize].join("/");
                let abs = fl & 1 != 0;
                let mut s = if abs { format!("/{names_s}") } else { names_s };
                if sub > 0 {
                    s.push(':');
                    s.push_str(&parts[names as usize..].join(":"));
                }
                tag("NodePath", Value::String(s))
            } else {
                // 3.x style: n is the string length
                r.p -= 4;
                tag("NodePath", Value::String(r.string()?))
            }
        }
        23 => tag("RID", Value::String(r.u64()?.to_string())),
        24 => {
            if f & 1 != 0 {
                json!({"$":"Object","id": r.u64()?.to_string()})
            } else {
                let class = r.string()?;
                if class.is_empty() {
                    Value::Null
                } else {
                    let n = r.u32()?;
                    let mut props = Vec::new();
                    for _ in 0..n {
                        let k = r.string()?;
                        let v = decode_one(r)?;
                        props.push(json!([k, v]));
                    }
                    json!({"$":"Object","class": class, "props": props})
                }
            }
        }
        25 => json!({"$":"Callable"}),
        26 => json!({"$":"Signal"}),
        27 => {
            let n = (r.u32()? & 0x7fff_ffff) as usize;
            container_hint(r, f & 3)?;
            container_hint(r, (f >> 2) & 3)?;
            let mut pairs = Vec::new();
            for _ in 0..n {
                let k = decode_one(r)?;
                let v = decode_one(r)?;
                pairs.push(json!([k, v]));
            }
            tag("Dictionary", Value::Array(pairs))
        }
        28 => {
            let n = (r.u32()? & 0x7fff_ffff) as usize;
            container_hint(r, f & 3)?;
            let mut a = Vec::new();
            for _ in 0..n {
                a.push(decode_one(r)?);
            }
            Value::Array(a)
        }
        29 => {
            let n = r.u32()? as usize;
            r.need(n)?;
            r.p += n + (4 - n % 4) % 4;
            json!({"$":"PackedByteArray","n": n})
        }
        30 | 31 | 32 | 33 => {
            let n = r.u32()? as usize;
            let w = if t == 30 || t == 32 { 4 } else { 8 };
            r.need(n * w)?;
            let mut v = Vec::new();
            for _ in 0..n.min(PACKED_CAP) {
                v.push(match t {
                    30 => json!(r.i32()?),
                    31 => json!(r.i64()?),
                    32 => num(r.f32()?),
                    _ => num(r.f64()?),
                });
            }
            r.p += (n - n.min(PACKED_CAP)) * w;
            let name = ["PackedInt32Array", "PackedInt64Array", "PackedFloat32Array", "PackedFloat64Array"][(t - 30) as usize];
            json!({"$": name, "v": v, "n": n})
        }
        34 => {
            let n = r.u32()? as usize;
            let mut v = Vec::new();
            for _ in 0..n {
                let s = r.string()?;
                if v.len() < PACKED_CAP {
                    v.push(Value::String(s));
                }
            }
            json!({"$":"PackedStringArray","v": v,"n": n})
        }
        35 | 36 | 37 | 38 => {
            let n = r.u32()? as usize;
            let k = [2usize, 3, 4, 4][(t - 35) as usize];
            r.need(n * k * 4)?;
            let mut v = Vec::new();
            for _ in 0..n.min(PACKED_CAP) {
                v.push(floats(r, k)?);
            }
            r.p += (n - n.min(PACKED_CAP)) * k * 4;
            let name = ["PackedVector2Array", "PackedVector3Array", "PackedColorArray", "PackedVector4Array"][(t - 35) as usize];
            json!({"$": name, "v": v, "n": n})
        }
        _ => return Err(format!("variant: unknown type {t}")),
    })
}

/// Decodes one packet payload. Never fails as a whole when the first elements are readable: a value that cannot be decoded
/// becomes `{"$":"Error","v":"…"}` (and ends the array), so the command name is always delivered.
pub fn decode(buf: &[u8]) -> R<Value> {
    let mut r = Rd { b: buf, p: 0 };
    let hdr = r.u32()?;
    if hdr & 0xff != 28 {
        return Err("packet is not an array".into());
    }
    let n = (r.u32()? & 0x7fff_ffff) as usize;
    let mut out = Vec::new();
    for _ in 0..n {
        match decode_one(&mut r) {
            Ok(v) => out.push(v),
            Err(e) => {
                out.push(json!({"$":"Error","v": e}));
                break;
            }
        }
    }
    Ok(Value::Array(out))
}

fn put_u32(o: &mut Vec<u8>, v: u32) {
    o.extend_from_slice(&v.to_le_bytes());
}
fn put_string(o: &mut Vec<u8>, s: &str) {
    put_u32(o, s.len() as u32);
    o.extend_from_slice(s.as_bytes());
    for _ in 0..(4 - s.len() % 4) % 4 {
        o.push(0);
    }
}

pub fn encode_value(o: &mut Vec<u8>, v: &Value) -> R<()> {
    match v {
        Value::Null => put_u32(o, 0),
        Value::Bool(b) => {
            put_u32(o, 1);
            put_u32(o, *b as u32);
        }
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                put_u32(o, 2 | (1 << 16));
                o.extend_from_slice(&i.to_le_bytes());
            } else {
                put_u32(o, 3 | (1 << 16));
                o.extend_from_slice(&n.as_f64().unwrap_or(0.0).to_le_bytes());
            }
        }
        Value::String(s) => {
            put_u32(o, 4);
            put_string(o, s);
        }
        Value::Array(a) => {
            put_u32(o, 28);
            put_u32(o, a.len() as u32);
            for x in a {
                encode_value(o, x)?;
            }
        }
        Value::Object(m) => match (m.get("$").and_then(Value::as_str), m.get("v")) {
            (Some("int"), Some(Value::String(s))) => {
                let i: i64 = s.parse().map_err(|_| "bad int")?;
                put_u32(o, 2 | (1 << 16));
                o.extend_from_slice(&i.to_le_bytes());
            }
            (Some("StringName"), Some(Value::String(s))) => {
                put_u32(o, 21);
                put_string(o, s);
            }
            _ => return Err("cannot encode object".into()),
        },
    }
    Ok(())
}

/// A debugger message: Array [command, thread_id, data...] framed with a 4-byte little-endian length.
pub fn frame_message(cmd: &str, thread: i64, data: &[Value]) -> R<Vec<u8>> {
    let mut body = Vec::new();
    let msg = Value::Array(vec![json!(cmd), json!(thread), Value::Array(data.to_vec())]);
    encode_value(&mut body, &msg)?;
    let mut out = Vec::with_capacity(body.len() + 4);
    put_u32(&mut out, body.len() as u32);
    out.extend(body);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_message() {
        let f = frame_message("evaluate", 1, &[json!("x + 1"), json!(0)]).unwrap();
        let len = u32::from_le_bytes(f[..4].try_into().unwrap()) as usize;
        assert_eq!(len, f.len() - 4);
        let v = decode(&f[4..]).unwrap();
        assert_eq!(v, json!(["evaluate", 1, ["x + 1", 0]]));
    }

    #[test]
    fn decodes_real_stack_frame_var_packet() {
        // ["stack_frame_var", 1, ["self", 1, 24 (object as id), <id>, "Node2D"]]
        let mut b = Vec::new();
        let obj_id: u64 = 26709329361;
        let mut inner = Vec::new();
        put_u32(&mut inner, 28);
        put_u32(&mut inner, 5);
        encode_value(&mut inner, &json!("self")).unwrap();
        encode_value(&mut inner, &json!(1)).unwrap();
        encode_value(&mut inner, &json!(24)).unwrap();
        put_u32(&mut inner, 24 | (1 << 16));
        inner.extend_from_slice(&obj_id.to_le_bytes());
        encode_value(&mut inner, &json!("Node2D")).unwrap();
        put_u32(&mut b, 28);
        put_u32(&mut b, 3);
        encode_value(&mut b, &json!("stack_frame_var")).unwrap();
        encode_value(&mut b, &json!(1)).unwrap();
        b.extend(inner);
        let v = decode(&b).unwrap();
        assert_eq!(v[2][3], json!({"$":"Object","id":"26709329361"}));
        assert_eq!(v[2][4], json!("Node2D"));
    }

    #[test]
    fn dictionary_vector_and_floats() {
        let mut b = Vec::new();
        put_u32(&mut b, 28);
        put_u32(&mut b, 1);
        put_u32(&mut b, 27);
        put_u32(&mut b, 1);
        encode_value(&mut b, &json!("pos")).unwrap();
        put_u32(&mut b, 5);
        b.extend_from_slice(&1.5f32.to_le_bytes());
        b.extend_from_slice(&(-2.0f32).to_le_bytes());
        let v = decode(&b).unwrap();
        assert_eq!(v[0], json!({"$":"Dictionary","v":[["pos",{"$":"Vector2","v":[1.5,-2.0]}]]}));
    }

    #[test]
    fn bad_value_keeps_command() {
        let mut b = Vec::new();
        put_u32(&mut b, 28);
        put_u32(&mut b, 2);
        encode_value(&mut b, &json!("cmd")).unwrap();
        put_u32(&mut b, 99);
        let v = decode(&b).unwrap();
        assert_eq!(v[0], json!("cmd"));
        assert_eq!(v[1]["$"], json!("Error"));
    }
}
