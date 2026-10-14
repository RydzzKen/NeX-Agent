import { isCtrlTab, isPrintableText, stripAnsi, type Key } from "../../util/ansi.js";
import { PROMPT_EOF, type PrompterLike } from "../prompt.js";
import { completeLine } from "../complete.js";
import type { Screen } from "./screen.js";

/** Nama tombol readline yang relevan untuk input TUI. */
const ENTER = "return";
const TAB = "tab";
const BACKSPACE = "backspace";
const DELETE = "delete";
const LEFT = "left";
const RIGHT = "right";
const HOME = "home";
const END = "end";
const UP = "up";
const DOWN = "down";
const ESC = "escape";

/**
 * Implementasi `PrompterLike` untuk TUI. Tidak memakai readline: input dibaca
 * dari layar (raw mode) lewat `consume(key)`. `pause`/`resume` sengaja
 * no-op — raw mode tetap aktif selama task berjalan (run_shell memakai pipe,
 * jadi tidak ada konflik pembaca TTY).
 */
export class TuiPrompter implements PrompterLike {
  private pending?: { resolve: (value: string) => void; secret: boolean };
  private closed = false;
  private interruptHandler?: () => void;

  constructor(
    private readonly screen: Screen,
    private readonly commands: string[],
    private readonly cwd: string,
  ) {}

  get hasPending(): boolean {
    return this.pending !== undefined;
  }

  question(query: string): Promise<string> {
    return this.ask(query, false);
  }

  secretQuestion(query: string, _mask?: string): Promise<string> {
    return this.ask(query, true);
  }

  pause(): void {
    // no-op: layar tetap mengelola key selama task berjalan.
  }

  resume(): void {
    // no-op.
  }

  onInterrupt(handler: () => void): void {
    this.interruptHandler = handler;
  }

  /** Panggil handler Ctrl+C yang didaftarkan app (jika ada). */
  triggerInterrupt(): void {
    this.interruptHandler?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const p = this.pending;
    this.pending = undefined;
    this.screen.clearMenu();
    this.screen.clearInput();
    p?.resolve(PROMPT_EOF);
  }

  private ask(query: string, secret: boolean): Promise<string> {
    const prompt = stripAnsi(query).replace(/\n/g, " ").trim() || "› ";
    this.screen.clearMenu();
    this.screen.setInput("", 0, secret, `${prompt} `);
    return new Promise<string>((resolve) => {
      this.pending = { resolve, secret };
    });
  }

  /**
   * Proses satu key saat ada pertanyaan menganggur. `true` bila dikonsumsi
   * oleh input; `false` berarti dispatcher boleh menangani (Ctrl+C, Ctrl+Tab,
   * Ctrl+X, Ctrl+T, scroll).
   */
  consume(key: Key): boolean {
    if (!this.pending || this.closed) return false;
    const { name, ctrl, meta, sequence } = key;

    // Kombinasi global dibiarkan ke dispatcher.
    if (ctrl && (name === "c" || name === "x" || name === "t" || name === "l")) return false;
    if (isCtrlTab(key)) return false;

    if (name === ENTER) {
      const selected = this.screen.getMenuSelected();
      if (selected && this.screenMenuOpen()) {
        this.applyCompletion(selected);
        return true;
      }
      this.submit();
      return true;
    }

    if (name === TAB && !ctrl && !meta) {
      this.tabComplete();
      return true;
    }

    if ((name === UP || name === DOWN) && !ctrl && !meta) {
      if (this.screenMenuOpen()) {
        this.screen.menuSelect(name === UP ? -1 : 1);
        return true;
      }
      return false; // biarkan dispatcher: scroll view
    }

    if (name === BACKSPACE && !ctrl) {
      this.screen.deleteInput();
      this.refreshMenu();
      return true;
    }

    if (name === DELETE) {
      if (this.screen.getInputText().length === 0) return false;
      this.screen.forwardDeleteInput();
      this.refreshMenu();
      return true;
    }

    if (name === LEFT && !ctrl) {
      this.screen.moveCaret(-1);
      return true;
    }
    if (name === RIGHT && !ctrl) {
      this.screen.moveCaret(1);
      return true;
    }
    if (name === HOME) {
      this.screen.caretToStart();
      return true;
    }
    if (name === END) {
      this.screen.caretToEnd();
      return true;
    }
    if (name === ESC) {
      this.screen.clearMenu();
      return true;
    }

    // Ctrl+D: EOF saat kosong (keluar), hapus karakter bila tidak kosong.
    if (ctrl && name === "d") {
      if (this.screen.getInputText().length === 0) this.submit(PROMPT_EOF);
      else this.screen.forwardDeleteInput();
      return true;
    }

    // Karakter yang dapat dicetak. readline mengisi `name` untuk huruf/angka
    // (mis. "a" → name "a", "A" → name "a"), jadi JANGAN mengandalkan `name`;
    // pakai `sequence` mentah yang mempertahankan huruf besar/kecil dan simbol.
    if (!ctrl && !meta && isPrintableText(sequence)) {
      this.screen.insertInput(sequence);
      this.refreshMenu();
      return true;
    }

    return false;
  }

  private screenMenuOpen(): boolean {
    return this.screen.getMenuSelected() !== undefined;
  }

  private submit(value?: string): void {
    const p = this.pending;
    this.pending = undefined;
    this.screen.clearMenu();
    this.screen.clearInput();
    if (p) p.resolve(value ?? this.screen.getInputText());
  }

  private currentMenu(): { matches: string[]; token: string } {
    const text = this.screen.getInputText();
    const [hits, token] = completeLine(text, this.commands, this.cwd);
    const matches = hits.filter((h) => h !== token);
    return { matches, token };
  }

  private refreshMenu(): void {
    const { matches, token } = this.currentMenu();
    this.screen.setMenu(token, matches);
  }

  private tabComplete(): void {
    // Tab berulang: putar pilihan pada menu yang sudah terbuka.
    if (this.screenMenuOpen()) {
      this.screen.menuSelect(1);
      return;
    }
    const { matches } = this.currentMenu();
    if (matches.length === 1) {
      this.applyCompletion(matches[0]!);
      return;
    }
    this.refreshMenu();
  }

  private applyCompletion(completion: string): void {
    const text = this.screen.getInputText();
    const idx = text.lastIndexOf(" ");
    const prefix = idx >= 0 ? text.slice(0, idx + 1) : "";
    this.screen.setInput(
      prefix + completion,
      (prefix + completion).length,
      false,
      this.screen.getInputPrompt(),
    );
    this.refreshMenu();
  }
}