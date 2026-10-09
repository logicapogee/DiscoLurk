import type { ReadOnlyPage } from './page';
import { parseDocument } from './parse';
import { POST_WITH_NUMBER } from './selectors';

export const timeoutError = (message: string) => Object.assign(new Error(message), { name: 'TimeoutError' });

/**
 * A page whose address and DOM are set by the test; waits answer at once from the current DOM.
 * Navigations are recorded but change nothing by themselves; `onNavigate` decides what the next page shows.
 */
export class StaticPage implements ReadOnlyPage {
  readonly navigations: string[] = [];
  onNavigate: (kind: 'goto' | 'reload' | 'goBack', url?: string) => void = () => {};
  scrollError: Error | null = null;
  /** Called on every wheel step; tests use it to change what the page shows. */
  onWheel: (dy: number) => void = () => {};

  constructor(
    public address: string,
    public html: string,
  ) {}
  all(selector: string) {
    return Array.from(parseDocument(this.html).querySelectorAll(selector));
  }
  async goto(url: string) {
    this.navigations.push(`goto ${url}`);
    this.onNavigate('goto', url);
  }
  async reload() {
    this.navigations.push('reload');
    this.onNavigate('reload');
  }
  async goBack() {
    this.navigations.push('goBack');
    this.onNavigate('goBack');
  }
  url() {
    return this.address;
  }
  async title() {
    return '';
  }
  isClosed() {
    return false;
  }
  async viewportSize() {
    return { width: 1280, height: 800 };
  }
  async setViewportSize() {}
  async content() {
    return this.html;
  }
  async count(selector: string) {
    return this.all(selector).length;
  }
  async counts(selectors: readonly string[]) {
    return selectors.map((s) => this.all(s).length);
  }
  async text(selector: string) {
    return (await this.texts(selector))[0] ?? null;
  }
  async texts(selector: string) {
    return this.all(selector).map((e) => (e.textContent ?? '').trim());
  }
  async waitFor(selector: string) {
    if (this.all(selector).length === 0) throw timeoutError(`waitFor ${selector}`);
  }
  async waitForURL(url: RegExp) {
    if (!url.test(this.address)) throw timeoutError(`waitForURL ${url}`);
  }
  async scrollIntoView() {
    if (this.scrollError) throw this.scrollError;
  }
  async moveMouse() {}
  async wheel(_dx: number, dy: number) {
    this.onWheel(dy);
  }
  visibility: DocumentVisibilityState = 'visible';
  fronted = 0;
  visibilityState() {
    return this.visibility;
  }
  async bringToFront() {
    this.fronted++;
  }
  async postsInViewport() {
    return this.all(POST_WITH_NUMBER).map((e) => Number(e.getAttribute('data-post-number')));
  }
}

