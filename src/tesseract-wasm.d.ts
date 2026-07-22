// tesseract-wasm ships real types at dist/index.d.ts, but its package.json
// `exports` map has no "types" condition, so TS (moduleResolution: "bundler")
// can't resolve them automatically. Minimal ambient shim covering only the
// OCRClient surface actually used in src/services/ocrService.ts.
declare module 'tesseract-wasm' {
  export interface OCRClientInit {
    createWorker?: (url: string) => Worker;
    wasmBinary?: Uint8Array | ArrayBuffer;
    workerURL?: string;
  }

  export class OCRClient {
    constructor(init?: OCRClientInit);
    destroy(): Promise<void>;
    loadModel(model: string | ArrayBuffer): Promise<void>;
    loadImage(image: ImageBitmap | ImageData): Promise<void>;
    clearImage(): Promise<void>;
    getText(onProgress?: (progress: number) => void): Promise<string>;
  }
}
