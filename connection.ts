import { RedisRawReply, sendCommand } from "./io.ts";
import { BufReader, BufWriter } from "./vendor/https/deno.land/std/io/bufio.ts";
type Closer = Deno.Closer;

export interface Connection {
  closer: Closer;
  reader: BufReader;
  writer: BufWriter;
  maxRetryCount: number;
  retryInterval: number;
  isClosed: boolean;
  isConnected: boolean;
  close(): void;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
}

export type RedisConnectionOptions = {
  tls?: boolean;
  db?: number;
  password?: string;
  name?: string;
  maxRetryCount?: number;
  retryInterval?: number;
};

export class RedisConnection implements Connection {
  name: string | null = null;
  closer!: Closer;
  reader!: BufReader;
  writer!: BufWriter;
  maxRetryCount = 0;
  retryInterval = 1200;

  private retryCount = 0;
  private _isClosed = false;
  private _isConnected = false;
  private connectThunkified: () => Promise<RedisConnection>;

  get isClosed(): boolean {
    return this._isClosed;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  constructor(
    hostname: string,
    port: number | string,
    private options: RedisConnectionOptions,
  ) {
    this.connectThunkified = this.thunkifyConnect(hostname, port, options);
  }

  private thunkifyConnect(
    hostname: string,
    port: string | number,
    options: RedisConnectionOptions,
  ): () => Promise<RedisConnection> {
    return async () => {
      const dialOpts: Deno.ConnectOptions = {
        hostname,
        port: parsePortLike(port),
      };
      const conn: Deno.Conn = options?.tls
        ? await Deno.connectTls(dialOpts)
        : await Deno.connect(dialOpts);

      if (options.name) {
        this.name = options.name;
      }
      if (options.maxRetryCount) {
        this.maxRetryCount = options.maxRetryCount;
      }
      if (options.retryInterval) {
        this.retryInterval = options.retryInterval;
      }

      this.closer = conn;
      this.reader = new BufReader(conn);
      this.writer = new BufWriter(conn);
      this._isClosed = false;
      this._isConnected = true;

      try {
        if (options?.password != null) {
          await this.authenticate(options.password);
        }
        if (options?.db) {
          await this.selectDb(options.db);
        }
      } catch (error) {
        this.close();
        throw error;
      }

      return this as RedisConnection;
    };
  }

  private authenticate(password: string): Promise<RedisRawReply> {
    return sendCommand(this.writer, this.reader, "AUTH", password);
  }

  private selectDb(
    db: number | undefined = this.options.db,
  ): Promise<RedisRawReply> {
    if (!db) throw new Error("The database index is undefined.");
    return sendCommand(this.writer, this.reader, "SELECT", db);
  }

  /**
   * Connect to Redis server
   */
  async connect(): Promise<void> {
    await this.connectThunkified();
  }

  close() {
    this._isClosed = true;
    this._isConnected = false;
    try {
      this.closer!.close();
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) throw error;
    }
  }

  async reconnect(): Promise<void> {
    if (!this.reader.peek(1)) {
      throw new Error("Client is closed.");
    }
    try {
      await sendCommand(this.writer, this.reader, "PING");
      this._isConnected = true;
    } catch (error) {
      this._isConnected = false;
      return new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
          if (this.retryCount > this.maxRetryCount) {
            this.close();
            clearInterval(interval);
            reject(new Error("Could not reconnect"));
          }
          try {
            this.close();
            await this.connect();
            await sendCommand(this.writer, this.reader, "PING");
            this._isConnected = true;
            this.retryCount = 0;
            clearInterval(interval);
            resolve();
          } catch (err) {
            // retrying
          } finally {
            this.retryCount++;
          }
        }, this.retryInterval);
      });
    }
  }
}

function parsePortLike(port: string | number | undefined): number {
  let parsedPort: number;
  if (typeof port === "string") {
    parsedPort = parseInt(port);
  } else if (typeof port === "number") {
    parsedPort = port;
  } else {
    parsedPort = 6379;
  }
  if (!Number.isSafeInteger(parsedPort)) {
    throw new Error("Port is invalid");
  }
  return parsedPort;
}
