-- An edit names people as a post does (F19.7, F19.10; STATUS section 2.218).
--
-- Until now the people a message named were fixed when it was posted (0150's
-- guard refused any change to `mentions`), so a name written into an edit
-- told nobody, and a name taken out of the words stayed a mention: the person
-- went on being told they were named in words that no longer name them. A
-- person's edit of their own words may now change whom they name, in the
-- same statement as the words and never apart from them; the handler keeps
-- only the people whose name is in the new words and who can see the room,
-- as the post does (src/workspace/messages.ts). Nothing else about a message
-- may change with it, and nobody else may change it: the platform, the
-- control plane and an update from inside a trigger still change no one's
-- mentions.
--
-- What an edit owes: a person newly named is told as a post would tell them
-- (a mention in their Activity and badge, and the thread followed when the
-- message began one), and the edit's row in the feed names them, so their
-- open console hears that it names them (STATUS 2.210). A person taken out is
-- told nothing more: their mention of it goes, unless the message also calls
-- the whole room, which still names them. The room's `@room` is not changed
-- by an edit: calling everyone again is a post's to do.

-- The application role may write whom a message names, as it may its words;
-- the guard below holds when, and the handler whom.
GRANT UPDATE (mentions) ON room_messages TO palugada_app;

CREATE OR REPLACE FUNCTION app.room_messages_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  reader text := app.reader();
  me text := app.principal();
  words boolean := NEW.body IS DISTINCT FROM OLD.body OR NEW.edited_at IS DISTINCT FROM OLD.edited_at;
  named boolean := NEW.mentions IS DISTINCT FROM OLD.mentions;
  removal boolean := NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by;
  marked boolean := NEW.became IS DISTINCT FROM OLD.became OR NEW.became_by IS DISTINCT FROM OLD.became_by
                    OR NEW.became_at IS DISTINCT FROM OLD.became_at;
  task boolean := NEW.task_id IS DISTINCT FROM OLD.task_id;
  item boolean := NEW.inbox_item_id IS DISTINCT FROM OLD.inbox_item_id;
  drawn boolean := NEW.notice_values IS DISTINCT FROM OLD.notice_values;
  counted boolean := NEW.reply_count IS DISTINCT FROM OLD.reply_count
                     OR NEW.last_reply_position IS DISTINCT FROM OLD.last_reply_position;
BEGIN
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.room_id <> OLD.room_id
     OR NEW.position <> OLD.position OR NEW.thread_of IS DISTINCT FROM OLD.thread_of
     OR NEW.also_in_room <> OLD.also_in_room OR NEW.kind <> OLD.kind OR NEW.author <> OLD.author
     OR NEW.author_name IS DISTINCT FROM OLD.author_name OR NEW.notice_code IS DISTINCT FROM OLD.notice_code
     OR NEW.mentions_room <> OLD.mentions_room OR NEW.via <> OLD.via
     OR NEW.via_relay IS DISTINCT FROM OLD.via_relay OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a message''s author, room, kind, place and origin never change' USING ERRCODE = 'check_violation';
  END IF;

  IF pg_trigger_depth() > 1 THEN
    IF words OR named OR removal OR marked OR drawn OR (task AND NEW.task_id IS NOT NULL)
       OR (item AND NEW.inbox_item_id IS NOT NULL) THEN
      RAISE EXCEPTION 'only a reply count or a released link changes a message from inside the database'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF reader = 'people' THEN
    IF counted OR drawn OR item THEN
      RAISE EXCEPTION 'a person changes only the words, the removal or the work of a message'
        USING ERRCODE = 'check_violation';
    END IF;
    IF named AND NOT words THEN
      RAISE EXCEPTION 'the people a message names change only with its words' USING ERRCODE = 'check_violation';
    END IF;
    IF removal THEN
      IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN
        RAISE EXCEPTION 'a removed message stays removed' USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.author <> me AND me <> 'owner' THEN
        RAISE EXCEPTION 'only its author or the owner removes a message' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF marked OR task OR named THEN
        RAISE EXCEPTION 'a message is removed, or changed, not both' USING ERRCODE = 'check_violation';
      END IF;
      NEW.body := NULL;
      NEW.edited_at := OLD.edited_at;
      NEW.deleted_at := clock_timestamp();
      NEW.deleted_by := me;
      DELETE FROM room_message_revisions WHERE company_id = OLD.company_id AND message_id = OLD.id;
      UPDATE room_files SET path = NULL WHERE company_id = OLD.company_id AND message_id = OLD.id;
      RETURN NEW;
    END IF;
    IF words THEN
      IF OLD.author <> me OR OLD.kind <> 'text' THEN
        RAISE EXCEPTION 'only its author edits a message' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF OLD.deleted_at IS NOT NULL OR NEW.body IS NULL OR NEW.body IS NOT DISTINCT FROM OLD.body THEN
        RAISE EXCEPTION 'an edit gives a message new words' USING ERRCODE = 'check_violation';
      END IF;
      IF clock_timestamp() - OLD.created_at >= interval '24 hours' THEN
        RAISE EXCEPTION 'a message is edited within a day of being written' USING ERRCODE = 'check_violation';
      END IF;
      IF marked OR task THEN
        RAISE EXCEPTION 'a message is edited, or becomes work, not both' USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO room_message_revisions (company_id, message_id, body) VALUES (OLD.company_id, OLD.id, OLD.body);
      NEW.edited_at := clock_timestamp();
      RETURN NEW;
    END IF;
    IF marked THEN
      IF OLD.became IS NOT NULL OR NEW.became IS NULL OR NEW.became_by IS DISTINCT FROM me THEN
        RAISE EXCEPTION 'a message becomes something once, by the press of whoever is asking'
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'a removed message becomes nothing' USING ERRCODE = 'check_violation';
      END IF;
      IF task AND (OLD.task_id IS NOT NULL OR NEW.task_id IS NULL) THEN
        RAISE EXCEPTION 'a message carries the work it became, once' USING ERRCODE = 'check_violation';
      END IF;
      NEW.became_at := clock_timestamp();
      RETURN NEW;
    END IF;
    IF task THEN
      RAISE EXCEPTION 'a message carries work only when it becomes work' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSIF reader = 'platform' THEN
    IF words OR named OR removal OR marked OR counted THEN
      RAISE EXCEPTION 'the platform changes only what a card points at and how it was drawn'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSIF reader = 'control' THEN
    IF named THEN
      RAISE EXCEPTION 'the control plane never changes whom a message names' USING ERRCODE = 'check_violation';
    END IF;
    IF removal AND NOT (words AND NEW.body IS NOT NULL) AND NOT marked AND NOT task AND NOT item AND NOT drawn
       AND NOT counted AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NULL THEN
      NEW.body := NULL;
      NEW.edited_at := OLD.edited_at;
      DELETE FROM room_message_revisions WHERE company_id = OLD.company_id AND message_id = OLD.id;
      UPDATE room_files SET path = NULL WHERE company_id = OLD.company_id AND message_id = OLD.id;
      RETURN NEW;
    END IF;
    IF app.importing() AND counted AND NOT (words OR removal OR marked OR task OR item OR drawn) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'the control plane only leaves a tombstone when a message''s time is up, or recounts an import'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'a message is changed only by a person, the platform or the control plane'
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- What a change owes: the feed row 0150 writes, and for an edit that changed
-- whom it names, the attention of the people newly named and the end of it
-- for the people taken out. The feed row of such an edit carries its author
-- and the people newly named, which is what the hub marks as naming a
-- listener (`mentioned`); an edit that names nobody new is framed as before.
CREATE OR REPLACE FUNCTION app.room_messages_after_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  what text;
  person text;
  added text[] := '{}';
BEGIN
  IF NOT app.room_feed_on() THEN RETURN NULL; END IF;
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    what := 'delete';
  ELSIF NEW.body IS DISTINCT FROM OLD.body OR NEW.became IS DISTINCT FROM OLD.became THEN
    what := 'edit';
  ELSIF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.inbox_item_id IS DISTINCT FROM OLD.inbox_item_id
        OR NEW.notice_values IS DISTINCT FROM OLD.notice_values THEN
    what := 'card';
  ELSE
    -- A reply's count on its root: the reply's own row already said so.
    RETURN NULL;
  END IF;

  IF NEW.mentions IS DISTINCT FROM OLD.mentions THEN
    IF NOT NEW.mentions_room THEN
      DELETE FROM room_mentions n
       WHERE n.company_id = NEW.company_id AND n.message_id = NEW.id AND n.reason = 'mention'
         AND n.principal = ANY (OLD.mentions) AND NOT (n.principal = ANY (NEW.mentions));
    END IF;
    FOREACH person IN ARRAY NEW.mentions LOOP
      CONTINUE WHEN person = ANY (OLD.mentions) OR person = NEW.author;
      CONTINUE WHEN NOT app.room_visible_to(NEW.company_id, NEW.room_id, person);
      added := added || person;
      -- Someone told of it as a reply in a thread they follow is now named in
      -- it: told again, as a mention.
      INSERT INTO room_mentions (company_id, message_id, principal, reason)
      VALUES (NEW.company_id, NEW.id, person, 'mention')
      ON CONFLICT (company_id, message_id, principal) DO UPDATE SET reason = 'mention', seen_at = NULL
        WHERE room_mentions.reason <> 'mention';
      IF NEW.thread_of IS NULL THEN
        INSERT INTO room_follows (company_id, root_id, principal) VALUES (NEW.company_id, NEW.id, person)
        ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  IF cardinality(added) > 0 THEN
    PERFORM app.room_feed_write(NEW.company_id, NEW.room_id, what, NEW.id, NULL, NULL, NEW.author, added);
  ELSE
    PERFORM app.room_feed_write(NEW.company_id, NEW.room_id, what, NEW.id);
  END IF;
  RETURN NULL;
END $$;
