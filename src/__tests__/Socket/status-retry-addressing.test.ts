import { jest } from '@jest/globals'
import { setImmediate as nextTurn } from 'timers/promises'
import { proto } from '../../../WAProto/index.js'
import type { LIDMappingStore } from '../../Signal/lid-mapping'
import makeWASocket from '../../Socket'
import { WebSocketClient } from '../../Socket/Client/websocket'
import type { SignalDataTypeMap, SignalKeyStore, SignalRepositoryWithLIDStore } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import type { ILogger } from '../../Utils/logger'

const ME_ID = '5511999999999:3@s.whatsapp.net'
const ME_LID = '99999999999999:3@lid'
const MESSAGE_ID = '3EB0000000000000000001'

type SentXml = { xml: string }

const makeCapturingLogger = (sent: string[]): ILogger =>
	({
		level: 'trace',
		child: () => makeCapturingLogger(sent),
		trace: (entry: SentXml | string) => {
			if (typeof entry === 'object' && entry.xml) sent.push(entry.xml)
		},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		fatal: () => {}
	}) as unknown as ILogger

const emptyKeys: SignalKeyStore = {
	async get<T extends keyof SignalDataTypeMap>(): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
		return {}
	},
	async set() {}
}

// Every device already has a session, so the resend never needs the network.
const makeFakeSignalRepository = (): SignalRepositoryWithLIDStore =>
	({
		validateSession: async () => ({ exists: true }),
		encryptMessage: async () => ({ type: 'msg', ciphertext: new Uint8Array([1]) }),
		hasSenderKey: async () => false,
		jidToSignalProtocolAddress: (jid: string) => jid,
		lidMapping: {
			getLIDsForPNs: async () => null,
			getPNsForLIDs: async () => null,
			getLIDForPN: async () => null,
			getPNForLID: async () => null,
			getKnownLIDForPN: async () => null
		} as unknown as LIDMappingStore
	}) as unknown as SignalRepositoryWithLIDStore

const readStanzaAttrs = (xml: string): Record<string, string> => {
	const openingTag = xml.split('\n')[0]!
	return Object.fromEntries([...openingTag.matchAll(/(\w+)='([^']*)'/g)].map(([, key, value]) => [key!, value!]))
}

const resendToDevice = async (destinationJid: string, deviceJid: string) => {
	const sent: string[] = []
	const creds = initAuthCreds()
	const socket = makeWASocket({
		auth: { creds, keys: emptyKeys },
		logger: makeCapturingLogger(sent),
		makeSignalRepository: makeFakeSignalRepository
	})

	try {
		// Logging in only after the socket's first tick keeps it from starting the
		// event buffer, whose auto-flush timer would outlive the test.
		await nextTurn()
		creds.me = { id: ME_ID, lid: ME_LID }
		creds.account = proto.ADVSignedDeviceIdentity.fromObject({
			details: new Uint8Array([1]),
			accountSignature: new Uint8Array([1]),
			deviceSignature: new Uint8Array([1])
		})

		// The websocket is never opened: the stanza is logged right before the send fails.
		await expect(
			socket.relayMessage(
				destinationJid,
				{ conversation: 'status' },
				{ messageId: MESSAGE_ID, participant: { jid: deviceJid, count: 1 }, statusJidList: [] }
			)
		).rejects.toThrow('Connection Closed')
	} finally {
		await socket.end(undefined)
	}

	const stanza = sent.find(xml => xml.startsWith('<message ') && xml.includes(`id='${MESSAGE_ID}'`))
	if (!stanza) throw new Error('retry stanza was not sent')
	return readStanzaAttrs(stanza)
}

describe('retry resend addressing', () => {
	let connect: ReturnType<typeof jest.spyOn>

	beforeEach(() => {
		connect = jest.spyOn(WebSocketClient.prototype, 'connect').mockImplementation(() => {})
	})

	afterEach(() => {
		connect.mockRestore()
	})

	it('keeps status@broadcast as destination and names the device as participant', async () => {
		const attrs = await resendToDevice('status@broadcast', '100000000000001:5@lid')

		expect(attrs.to).toBe('status@broadcast')
		expect(attrs.participant).toBe('100000000000001:5@lid')
	})

	it('keeps the group as destination for group retries', async () => {
		const attrs = await resendToDevice('120363000000000000@g.us', '111:2@lid')

		expect(attrs.to).toBe('120363000000000000@g.us')
		expect(attrs.participant).toBe('111:2@lid')
	})

	it('sends 1:1 retries straight to the contact device', async () => {
		const attrs = await resendToDevice('5521888888888@s.whatsapp.net', '5521888888888:2@s.whatsapp.net')

		expect(attrs.to).toBe('5521888888888:2@s.whatsapp.net')
		expect(attrs.participant).toBeUndefined()
	})
})
