/** Pixel buffers are immutable to consumers. Visible canvases have their own storage. */
export class PageCache {
  private entries = new Map<string, ImageData>();
  private bytes = 0;
  constructor(private readonly budget = 64 * 1024 * 1024) {}
  get(key: string): ImageData | undefined {
    const value = this.entries.get(key);
    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: ImageData) {
    this.delete(key);
    if (value.data.byteLength > this.budget) return;
    this.entries.set(key, value);
    this.bytes += value.data.byteLength;
    while (this.bytes > this.budget)
      this.delete(this.entries.keys().next().value!);
  }
  private delete(key: string) {
    const value = this.entries.get(key);
    if (value) {
      this.bytes -= value.data.byteLength;
      this.entries.delete(key);
    }
  }
  removeDocument(id: number) {
    for (const key of this.entries.keys())
      if (key.startsWith(`${id}:`)) this.delete(key);
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
  get byteLength() {
    return this.bytes;
  }
}
