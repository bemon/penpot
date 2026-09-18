--- Add the file_commit table, which records the client supplied commit id of
--- every save this server applied.
---
--- The row is written in the same transaction as the file update, so its
--- presence means the changes are applied: a request repeating that commit id
--- is answered with the revision the first call returned.
---
--- The record lives apart from file_change because it must outlive any retry a
--- client may still be making, and costs a few dozen bytes per save against the
--- xlog's encoded payload.
---
--- The primary key makes a commit id unique per file, so the dedup does not
--- rest on the caller holding the file advisory lock.

CREATE TABLE file_commit (
  file_id    uuid NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  commit_id  uuid NOT NULL,

  created_at timestamptz NOT NULL,
  deleted_at timestamptz NULL,

  --- The revision the first call answered with: the file revision before the
  --- changes were applied.
  revn       bigint NOT NULL,

  PRIMARY KEY (file_id, commit_id)
);

--- objects-gc drains this table by deleted_at.
CREATE INDEX file_commit__deleted_at__idx
    ON file_commit (deleted_at) WHERE deleted_at IS NOT NULL;

COMMENT ON TABLE file_commit IS 'Client supplied commit id of every applied save. Used to answer a repeated update-file request without applying its changes again.';
