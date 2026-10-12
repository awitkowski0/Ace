//! Remote backend: delegates to `crate::remote::ops` (ssh, one multiplexed connection per host).
use super::*;
use crate::remote::ops;

pub struct RemoteBackend {
    pub host: String,
}

impl FsBackend for RemoteBackend {
    fn list_dir(&self, p: &str) -> FsResult<Vec<DirEntry>> { ops::list_dir(&self.host, p) }
    fn read_file(&self, p: &str) -> FsResult<String> { ops::read_file(&self.host, p) }
    fn write_file(&self, p: &str, c: &str) -> FsResult<()> { ops::write_file(&self.host, p, c) }
    fn stat(&self, p: &str) -> FsResult<FileStat> { ops::stat(&self.host, p) }
    fn rename(&self, a: &str, b: &str) -> FsResult<()> { ops::rename(&self.host, a, b) }
    fn delete(&self, p: &str) -> FsResult<()> { ops::delete(&self.host, p) }
    fn create_dir(&self, p: &str) -> FsResult<()> { ops::create_dir(&self.host, p) }
    fn copy(&self, a: &str, b: &str) -> FsResult<()> { ops::copy(&self.host, a, b) }
}
