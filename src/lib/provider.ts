import debug from 'debug';
import { EventEmitter } from 'events';
import { fromUint8Array } from 'js-base64';
import { fromBase64 } from 'lib0/buffer';
import { Channel } from 'pusher-js';
import Pusher from 'pusher-js/types/src/core/pusher';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

export interface PingerchipsProviderConfig {
  channel: string;
  tableName: string;
  columnName: string;
  idName?: string;
  id: string | number;
  awareness?: awarenessProtocol.Awareness;
  resyncInterval?: number | false;
}

export interface DocumentStore {
  /**
   * Get the latest document state.
   */
  get(): Promise<Uint8Array>;

  /**
   * Set the latest document state.
   */
  set(update: Uint8Array): Promise<void>;
}

export default class PingerchipsProvider extends EventEmitter {
  public awareness: awarenessProtocol.Awareness;
  public connected = false;
  private channel: Channel | null = null;

  private _synced: boolean = false;
  private resyncInterval: any;
  protected logger: debug.Debugger;
  public readonly id: number;

  public version: number = 0;
  private store: DocumentStore;

  isOnline(online?: boolean): boolean {
    if (!online && online !== false) return this.connected;
    this.connected = online;
    return this.connected;
  }

  onDocumentUpdate(update: Uint8Array, origin: any) {
    if (origin !== this) {
      this.logger(
        'document updated locally, broadcasting update to peers',
        this.isOnline()
      );

      this.emit('message', update);
      this.save();
    }
  }

  onAwarenessUpdate({ added, updated, removed }: any, origin: any) {
    const changedClients = added.concat(updated).concat(removed);
    const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
      this.awareness,
      changedClients
    );
    this.emit('awareness', awarenessUpdate);
  }

  removeSelfFromAwarenessOnUnload() {
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      'window unload'
    );
  }

  async save() {
    const content = Y.encodeStateAsUpdate(this.doc);
    try {
      await this.store.set(content);
    } catch (error) {
      this.emit('error', error);
    }

    this.emit('save', this.version);
  }

  private async onConnect() {
    this.logger('connected');

    const data = await this.store.get();

    this.logger('retrieved data from store', data);

    if (data) {
      this.logger('applying update to yjs');
      try {
        this.applyUpdate(data);
      } catch (error) {
        this.logger(error);
      }
    }

    this.logger('setting connected flag to true');
    this.isOnline(true);

    this.emit('status', [{ status: 'connected' }]);

    if (this.awareness.getLocalState() !== null) {
      const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
        this.awareness,
        [this.doc.clientID]
      );
      this.emit('awareness', awarenessUpdate);
    }
  }

  private applyUpdate(update: Uint8Array, origin?: any) {
    this.version++;
    Y.applyUpdate(this.doc, update, origin);
  }

  private disconnect() {
    if (this.channel) {
      this.channel.disconnect();
      this.channel = null;
    }
  }

  private connect() {
    this.channel = this.pusher.subscribe(this.config.channel);

    if (this.channel) {
      this.channel.bind('client-message', (data) => {
        this.onMessage(fromBase64(data), this);
      });

      this.channel.bind('client-awareness', (data) => {
        this.onAwareness(fromBase64(data));
      });

      this.channel.bind('pusher:error', (err) => {
        this.logger('PUSHER_ERROR', err);
        this.emit('error', this);
        this.emit('disconnect', this);
      });

      this.channel.bind('pusher:subscription_error', (err: any) => {
        const { status } = err;

        if (status === 403) {
          this.logger('PUSHER AUTH ERROR', err);
          this.emit('error', this);
          this.emit('disconnect', this);
        }
      });

      this.channel.bind('pusher:subscription_succeeded', (data) => {
        this.logger('PUSHER_SUBSCRIPTION_SUCCEEDED', data);
        this.emit('connect', this);
      });

      // this.channel
      //   .on(
      //     REALTIME_LISTEN_TYPES.BROADCAST,
      //     { event: 'message' },
      //     ({ payload }) => {
      //       this.onMessage(Uint8Array.from(payload), this);
      //     }
      //   )
      //   .on(
      //     REALTIME_LISTEN_TYPES.BROADCAST,
      //     { event: 'awareness' },
      //     ({ payload }) => {
      //       this.onAwareness(Uint8Array.from(payload));
      //     }
      //   )
      //   .subscribe((status, err) => {
      //     if (status === 'SUBSCRIBED') {
      //       this.emit('connect', this);
      //     }

      //     if (status === 'CHANNEL_ERROR') {
      //       this.logger('CHANNEL_ERROR', err);
      //       this.emit('error', this);
      //     }

      //     if (status === 'TIMED_OUT') {
      //       this.emit('disconnect', this);
      //     }

      //     if (status === 'CLOSED') {
      //       this.emit('disconnect', this);
      //     }
      //   });
    }
  }

  constructor(
    private doc: Y.Doc,
    private pusher: Pusher,
    private config: PingerchipsProviderConfig
  ) {
    super();

    this.awareness =
      this.config.awareness || new awarenessProtocol.Awareness(doc);

    //@ts-ignore
    this.config = config || {};
    this.id = doc.clientID;

    this.pusher = pusher;
    this.on('connect', this.onConnect);
    this.on('disconnect', this.onDisconnect);

    this.logger = debug('y-' + doc.clientID);
    // turn on debug logging to the console
    this.logger.enabled = true;

    this.logger('constructor initializing');
    this.logger('connecting to Pingerchips Realtime', doc.guid);

    if (
      this.config.resyncInterval ||
      typeof this.config.resyncInterval === 'undefined'
    ) {
      if (this.config.resyncInterval && this.config.resyncInterval < 3000) {
        throw new Error('resync interval of less than 3 seconds');
      }
      this.logger(
        `setting resync interval to every ${
          (this.config.resyncInterval || 5000) / 1000
        } seconds`
      );
      this.resyncInterval = setInterval(() => {
        this.logger('resyncing (resync interval elapsed)');
        this.emit('message', Y.encodeStateAsUpdate(this.doc));
        if (this.channel)
          this.channel.trigger(
            'client-message',
            fromUint8Array(Y.encodeStateAsUpdate(this.doc))
          );
      }, this.config.resyncInterval || 5000);
    }

    if (typeof window !== 'undefined') {
      window.addEventListener(
        'beforeunload',
        this.removeSelfFromAwarenessOnUnload
      );
    } else if (typeof process !== 'undefined') {
      process.on('exit', () => this.removeSelfFromAwarenessOnUnload);
    }
    this.on('awareness', (update) => {
      if (this.channel)
        this.channel.trigger('client-awareness', fromUint8Array(update));
    });
    this.on('message', (update) => {
      if (this.channel)
        this.channel.trigger('client-message', fromUint8Array(update));
    });

    this.connect();
    this.doc.on('update', this.onDocumentUpdate.bind(this));
    this.awareness.on('update', this.onAwarenessUpdate.bind(this));
  }

  get synced() {
    return this._synced;
  }

  set synced(state) {
    if (this._synced !== state) {
      this.logger('setting sync state to ' + state);
      this._synced = state;
      this.emit('synced', [state]);
      this.emit('sync', [state]);
    }
  }

  public onConnecting() {
    if (!this.isOnline()) {
      this.logger('connecting');
      this.emit('status', [{ status: 'connecting' }]);
    }
  }

  public onDisconnect() {
    this.logger('disconnected');

    this.synced = false;
    this.isOnline(false);
    this.logger('set connected flag to false');
    if (this.isOnline()) {
      this.emit('status', [{ status: 'disconnected' }]);
    }

    // update awareness (keep all users except local)
    // FIXME? compare to broadcast channel behavior
    const states = Array.from(this.awareness.getStates().keys()).filter(
      (client) => client !== this.doc.clientID
    );
    awarenessProtocol.removeAwarenessStates(this.awareness, states, this);
  }

  public onMessage(message: Uint8Array, origin: any) {
    if (!this.isOnline()) return;
    try {
      this.applyUpdate(message, this);
    } catch (err) {
      this.logger(err);
    }
  }

  public onAwareness(message: Uint8Array) {
    awarenessProtocol.applyAwarenessUpdate(this.awareness, message, this);
  }

  public onAuth(message: Uint8Array) {
    this.logger(`received ${message.byteLength} bytes from peer: ${message}`);

    if (!message) {
      this.logger(`Permission denied to channel`);
    }
    this.logger('processed message (type = MessageAuth)');
  }

  public destroy() {
    this.logger('destroying');

    if (this.resyncInterval) {
      clearInterval(this.resyncInterval);
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener(
        'beforeunload',
        this.removeSelfFromAwarenessOnUnload
      );
    } else if (typeof process !== 'undefined') {
      process.off('exit', () => this.removeSelfFromAwarenessOnUnload);
    }

    this.awareness.off('update', this.onAwarenessUpdate);
    this.doc.off('update', this.onDocumentUpdate);

    if (this.channel) this.disconnect();
  }
}
