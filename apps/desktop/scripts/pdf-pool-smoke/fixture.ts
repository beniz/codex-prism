export function pdf(pages: number, heavy = false, label = ""): ArrayBuffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const children: string[] = [];
  for (let i = 0; i < pages; i++) {
    const id = objects.length + 1;
    children.push(`${id} 0 R`);
    let stream =
      "BT /F1 12 Tf 40 800 Td " +
      Array.from(
        { length: 45 },
        (_, j) =>
          `(${label} Page ${i + 1}, scientific text line ${j}) Tj 0 -16 Td\n`,
      ).join("") +
      "ET\n";
    if (heavy)
      stream +=
        "0.2 w\n" +
        Array.from(
          { length: 700000 },
          (_, j) => `${j % 550} ${(j * 17) % 780} 12 12 re S\n`,
        ).join("");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages} /Kids [${children.join(" ")}] >>`;
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const start = text.length;
  text +=
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new TextEncoder().encode(text).buffer;
}
