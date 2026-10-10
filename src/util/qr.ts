import qrcode from "qrcode-terminal";

/**
 * Render teks (mis. URL) menjadi kode QR untuk terminal memakai blok Unicode.
 * Dipakai agar ponsel bisa langsung memindai tautan `serve`.
 */
export function renderQr(text: string): string {
  let output = "";
  qrcode.generate(text, { small: true }, (qr: string) => {
    output = qr;
  });
  return output.replace(/\n+$/, "");
}

/** Ubah kode QR menjadi baris-baris siap cetak. */
export function qrLines(text: string): string[] {
  return renderQr(text).split("\n");
}
