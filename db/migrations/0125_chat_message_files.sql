-- What a customer attached to a message, kept (the audit of 6 October, P1.4
-- part 5).
--
-- A purchase order or a price list that arrives by email was thrown away with
-- the sentence "which cannot be read here". Its file is now kept in the
-- company's files, under a path the platform makes (`received/mail/2026-10/
-- 0a1b2c3d-1.pdf`), and this column says which files a message carried and what
-- became of each: the path when it was kept, the reason when it was not.
--
-- No table: the folder is the store and the message is the owner of the link.
-- Each element is { kind, name, path, bytes, note }, where `name` is what the
-- sender called it, made plain and short for display -- theirs, so data -- and
-- `path` is null when it was not kept. At most five, as a message keeps at most
-- five, and at most 8 KB all told, so a stranger cannot make a message heavy.
--
-- The column is written by the control plane when the message is received, like
-- the task it starts (`UPDATE ... SET task_id`); the application role has no
-- UPDATE on this table (0111), so a run cannot give a message a file.
ALTER TABLE chat_messages
  ADD COLUMN files jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT chat_messages_files_bounded CHECK (
    jsonb_typeof(files) = 'array' AND jsonb_array_length(files) <= 5 AND pg_column_size(files) <= 8192
  );
