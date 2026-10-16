const W = 40, H = 20;
let out = "\n";

for (let y = 0; y <= H; y++) {
  let line = "";
  for (let x = 0; x < W; x++) {
    const px = x / 2; // koreksi tinggi karakter
    const d1 = Math.hypot(px - 10, y - 10);
    const d2 = Math.hypot(px - 13.5, y - 8);
    if (d1 <= 9 && d2 > 7.5) {
      const t = (px + y) / 30;
      const v = Math.round(35 + t * 140); // gelap -> abu
      line += `\x1b[38;2;${v};${v};${v}m█`;
    } else line += " ";
  }
  out += line + "\x1b[0m\n";
}

out += "\n" + " ".repeat(14) + "\x1b[1;38;2;200;200;200mNeX-Agent\x1b[0m\n";
console.log(out);
