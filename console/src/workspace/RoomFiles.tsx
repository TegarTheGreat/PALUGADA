/**
 * The files a message carries (F19.4; STATUS 2.212).
 *
 * A file is read from the server as the person, with its bytes in base64
 * inside JSON, as every answer is. A picture is drawn only when the server
 * says it may be (`inline`: a small PNG, JPEG, WebP or GIF), from a data
 * address the console's policy allows; everything else -- an SVG, a page, a
 * program -- is saved on the device as an octet stream under its name, and
 * never opened in the console's origin. Nothing is kept in the browser: a
 * picture drawn is held by this row while it is on screen, and saved bytes
 * are handed to the device and let go.
 */
import { useEffect, useState } from 'react';
import { Anchor, Box, Group, Image, Text, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconFile } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { fileSize } from '../format.ts';
import { t } from '../i18n.ts';
import { useScope } from './scope.ts';
import type { FileView } from './types.ts';

/** A file as the server answers it. */
type Read = { name: string; mime: string; bytes: number; inline: boolean; data: string };

/** Saves a file's bytes on the device under its name, as bytes and nothing else. */
function save(file: Read): void {
  const raw = atob(file.data);
  const bytes = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at += 1) bytes[at] = raw.charCodeAt(at);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.rel = 'noopener';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A picture as it is drawn: what the server answered, and its own width and height. */
type Sized = Read & { width: number; height: number };

/** The most a picture is drawn across and down, in CSS pixels. */
const PICTURE_WIDE = 320;
const PICTURE_HIGH = 240;

/**
 * A picture's own size, read from its bytes before it is put on the page. Put
 * there unread, a picture has no height until the browser has read it, and
 * what the room's log holds shrinks under the view and grows again: a log at
 * its newest is moved up and has to tell that from the person scrolling
 * (STATUS 2.220). Bytes that are not a picture are refused, and the file is
 * offered to be saved instead.
 */
function sized(file: Read): Promise<Sized> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve({ ...file, width: image.naturalWidth, height: image.naturalHeight });
      else reject(new Error(`${file.name} has no size to draw`));
    };
    image.onerror = () => reject(new Error(`${file.name} is not a picture the browser can read`));
    image.src = `data:${file.mime};base64,${file.data}`;
  });
}

/** A picture the server says may be drawn, read when its row is drawn and put on the page in a box of its own shape. */
function Picture({ roomId, file }: { roomId: string; file: FileView }) {
  const scope = useScope();
  const [read, setRead] = useState<Sized | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api('GET', `/api/companies/${scope.companyId}/rooms/${roomId}/files/${file.id}`)
      .then((answer: Read) => (answer.inline ? sized(answer) : { ...answer, width: 0, height: 0 }))
      .then((answer) => { if (live) setRead(answer); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [scope.companyId, roomId, file.id]);
  if (failed || (read && !read.inline)) return <Saved roomId={roomId} file={file} />;
  // As wide as the message allows up to PICTURE_WIDE, and no wider than keeps it PICTURE_HIGH at most: the box is
  // the picture's shape, and its height is known before the picture is drawn in it.
  const box = read ? { width: `min(${PICTURE_WIDE}px, 100%, ${Math.floor((PICTURE_HIGH * read.width) / read.height)}px)` } : {};
  return (
    <UnstyledButton className="room-picture" aria-label={t('Save {name}', { name: file.name })} onClick={() => { if (read) save(read); }}
      style={{ maxWidth: '100%', minWidth: 0, ...box }}>
      {read
        ? <Image src={`data:${read.mime};base64,${read.data}`} alt={file.name} radius="sm" fit="contain"
          style={{ aspectRatio: `${read.width} / ${read.height}`, height: 'auto' }} />
        : <Box w={160} h={96} className="room-picture-loading" />}
    </UnstyledButton>
  );
}

/** Any other file: its name and size, saved when pressed. */
export function Saved({ roomId, file }: { roomId: string; file: FileView }) {
  const scope = useScope();
  const [saving, setSaving] = useState(false);
  const download = async () => {
    setSaving(true);
    try {
      const answer: Read = await api('GET', `/api/companies/${scope.companyId}/rooms/${roomId}/files/${file.id}`);
      save(answer);
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setSaving(false);
    }
  };
  // As wide as the message at most, however long the name: the name is cut
  // short and the button stays on the screen, a phone's too (F19.16).
  return (
    <Group gap={8} wrap="nowrap" className="room-file" data-file={file.id} style={{ maxWidth: '100%', minWidth: 0 }}>
      <IconFile size={18} />
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Text size="sm" truncate dir="auto">{file.name}</Text>
        <Text size="xs" c="dimmed">{fileSize(file.bytes)}</Text>
      </Box>
      <Anchor component="button" type="button" size="xs" onClick={() => void download()} aria-label={t('Save {name}', { name: file.name })}
        disabled={saving}>
        <IconDownload size={16} />
      </Anchor>
    </Group>
  );
}

export function RoomFiles({ roomId, files, removed }: { roomId: string; files: FileView[]; removed: boolean }) {
  if (files.length === 0) return null;
  // A removed message keeps no file: its names are not shown either.
  if (removed) return null;
  return (
    <Group gap={8} mt={4} align="flex-start" wrap="wrap" w="100%" data-files>
      {files.map((file) => (file.inline
        ? <Picture key={file.id} roomId={roomId} file={file} />
        : <Saved key={file.id} roomId={roomId} file={file} />))}
    </Group>
  );
}
