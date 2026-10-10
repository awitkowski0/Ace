//! Stub remote backend. The remote agent implements these (SFTP / ssh) — keep the struct + trait impl.
use super::*;

pub struct RemoteBackend {
    pub host: String,
}

fn ni<T>(host: &str) -> FsResult<T> {
    Err(format!("remote fs not implemented (host: {host})"))
}

impl FsBackend for RemoteBackend {
    fn list_dir(&self, _: &str) -> FsResult<Vec<DirEntry>> { ni(&self.host) }
    fn read_file(&self, _: &str) -> FsResult<String> { ni(&self.host) }
    fn write_file(&self, _: &str, _: &str) -> FsResult<()> { ni(&self.host) }
    fn stat(&self, _: &str) -> FsResult<FileStat> { ni(&self.host) }
    fn rename(&self, _: &str, _: &str) -> FsResult<()> { ni(&self.host) }
    fn delete(&self, _: &str) -> FsResult<()> { ni(&self.host) }
    fn create_dir(&self, _: &str) -> FsResult<()> { ni(&self.host) }
}
