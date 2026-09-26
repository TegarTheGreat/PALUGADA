/**
 * Runtime devices (F12.7, F12.10): a runtime that is not this process is a
 * device with a key. It is pending until you pair it, it proves itself by
 * signing a challenge, and it may only read until you vouch for it.
 */
import { useState } from 'react';
import {
  Alert, Badge, Button, Checkbox, Code, CopyButton, Group, Modal, Paper, Stack, Table, Text,
  TextInput, Title, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCopy, IconPlus } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import type { Device } from '../types.ts';
import { relative } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { EmptyState, LoadFailed, Loading } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';

const STATUS: Record<string, string> = { pending: 'orange', paired: 'teal', revoked: 'gray' };

export function Devices({ ctx }: PageProps) {
  const { companyId } = ctx;
  const devices = useLoad(async () => {
    const answer: { devices: Device[] } = await api('GET', `/api/companies/${companyId}/devices`);
    return answer.devices;
  }, [companyId]);
  const [registering, setRegistering] = useState(false);
  const [registered, setRegistered] = useState<{ id: string; keyFingerprint: string } | null>(null);
  const [pairing, setPairing] = useState<Device | null>(null);
  const [nonce, setNonce] = useState<string | null>(null);

  // The route needs the owner's session, so a device cannot ask for its own
  // nonce: the owner takes one here and carries it across.
  const challenge = async (device: Device) => {
    try {
      const answer: { nonce: string } = await api('POST', `/api/companies/${companyId}/devices/${device.id}/challenge`, {});
      setNonce(answer.nonce);
    } catch (failure) {
      notifications.show({ color: 'red', message: (failure as Error).message });
    }
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Text size="sm" c="dimmed" fw={600}>{ctx.company.name}</Text>
          <Title order={2}>Devices</Title>
        </div>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setRegistering(true)}>Register a device</Button>
      </Group>

      {devices.error ? <LoadFailed message={devices.error} retry={devices.reload} /> : !devices.data ? <Loading /> : (
        <Paper withBorder radius="md" style={{ overflow: 'hidden' }}>
          {devices.data.length === 0 ? (
            <EmptyState title="No devices" description="A runtime outside this process -- a laptop running an agent CLI, a build box -- registers its public key here, and does nothing until you pair it." />
          ) : (
            <Table.ScrollContainer minWidth={720}>
              <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                <Table.Thead><Table.Tr><Table.Th>Device</Table.Th><Table.Th>Status</Table.Th><Table.Th>Key</Table.Th><Table.Th>Last seen</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {devices.data.map((device) => (
                    <Table.Tr key={device.id}>
                      <Table.Td><Text size="sm" fw={600}>{device.name}</Text><Text size="xs" c="dimmed">{device.runtime}</Text></Table.Td>
                      <Table.Td>
                        <Group gap={6}>
                          <Badge color={STATUS[device.status] ?? 'gray'} variant="light">{device.status}</Badge>
                          {device.quarantined && device.status !== 'revoked' && <Tooltip label="May read; may not change anything (F12.10)"><Badge color="orange" variant="outline">read only</Badge></Tooltip>}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        {device.keyFingerprint ? (
                          <CopyButton value={device.keyFingerprint}>
                            {({ copied, copy }) => (
                              <Tooltip label={copied ? 'Copied' : device.keyFingerprint}>
                                <Code style={{ cursor: 'pointer' }} onClick={copy}>{device.keyFingerprint!.slice(0, 16)}…</Code>
                              </Tooltip>
                            )}
                          </CopyButton>
                        ) : <Badge color="red" variant="light">not a key</Badge>}
                      </Table.Td>
                      <Table.Td><Text size="sm" c="dimmed">{relative(device.lastSeenAt)}</Text></Table.Td>
                      <Table.Td>
                        <Group gap="xs" justify="flex-end" wrap="nowrap">
                          {device.status !== 'revoked' && (
                            <Button size="xs" variant="light" onClick={() => setPairing(device)}>
                              {device.status === 'paired' ? 'Re-pair' : 'Pair'}
                            </Button>
                          )}
                          {device.status === 'paired' && <Button size="xs" variant="default" onClick={() => void challenge(device)}>Challenge</Button>}
                          {device.status !== 'revoked' && (
                            <ActionButton size="xs" color="red" variant="subtle" label="Revoke"
                              run={() => api('POST', `/api/companies/${companyId}/devices/${device.id}/revoke`, {})} done={devices.reload} />
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Paper>
      )}

      <Modal opened={registering} onClose={() => { setRegistering(false); setRegistered(null); }} title="Register a device" centered size="lg">
        {registered ? (
          <Stack>
            <Alert color="teal" variant="light" title="Registered">
              Pair it only if the machine shows the same fingerprint:
            </Alert>
            <Code block>{registered.keyFingerprint}</Code>
            <Text size="xs" c="dimmed">On the machine: <Code>openssl pkey -pubin -in key.pem -outform DER | sha256sum</Code></Text>
          </Stack>
        ) : (
          <ActionForm
            columns={2}
            fields={[
              { name: 'name', label: 'Name', required: true, placeholder: 'build box' },
              { name: 'runtime', label: 'Runtime', required: true, placeholder: 'claude-code' },
              { name: 'publicKeyPem', label: 'Public key, PEM', type: 'textarea', required: true },
            ]}
            submit={(values) => api('POST', `/api/companies/${companyId}/devices`, values)}
            action="Register"
            done={(result) => { setRegistered(result as { id: string; keyFingerprint: string }); devices.reload(); }}
          />
        )}
      </Modal>

      <PairModal companyId={companyId} device={pairing} close={() => setPairing(null)} paired={devices.reload} />

      <Modal opened={nonce !== null} onClose={() => setNonce(null)} title="Hand this to the device" centered>
        <Stack>
          <Text size="sm" c="dimmed">The device signs it and connects. It is good for two minutes, once.</Text>
          <Code block style={{ wordBreak: 'break-all', userSelect: 'all' }}>{nonce}</Code>
          <CopyButton value={nonce ?? ''}>{({ copied, copy }) => <Button leftSection={<IconCopy size={16} />} onClick={copy} variant="light">{copied ? 'Copied' : 'Copy'}</Button>}</CopyButton>
        </Stack>
      </Modal>
    </Stack>
  );
}

/**
 * Pairing names the key: the fingerprint the owner compared with the machine,
 * so a key swapped in between is refused. Lifting the quarantine is a
 * separate claim -- "I know this machine" is not "I vouch for what it does".
 */
function PairModal({ companyId, device, close, paired }: { companyId: string; device: Device | null; close: () => void; paired: () => void }) {
  const requireFactor = useFactor();
  const [fingerprint, setFingerprint] = useState('');
  const [lift, setLift] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pair = async () => {
    if (!device) return;
    setError(null);
    try {
      const done = await requireFactor(`Pair ${device.name}`, (proof) => api('POST', `/api/companies/${companyId}/devices/${device.id}/pair`, {
        keyFingerprint: fingerprint, liftQuarantine: lift, proof,
      }));
      if (!done) return;
      notifications.show({ color: 'teal', message: `${device.name} is paired.` });
      setFingerprint('');
      setLift(false);
      close();
      paired();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <Modal opened={device !== null} onClose={close} title={`Pair ${device?.name ?? ''}`} centered size="lg">
      <Stack>
        <Text size="sm">Compare with the fingerprint the machine itself prints, then type or paste it here.</Text>
        <TextInput label="Key fingerprint, as the machine shows it" value={fingerprint} onChange={(event) => setFingerprint(event.currentTarget.value)} ff="monospace" required />
        <Checkbox label="Also lift its quarantine (let it change things, not only read)" checked={lift} onChange={(event) => setLift(event.currentTarget.checked)} />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>Cancel</Button>
          <Button disabled={!fingerprint.trim()} onClick={() => void pair()}>Pair it</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

