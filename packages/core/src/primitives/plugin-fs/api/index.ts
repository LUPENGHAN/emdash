export interface PluginFs {
  /** The absolute directory paths are relative to, when it is on this computer. */
  readonly root?: string;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
}
