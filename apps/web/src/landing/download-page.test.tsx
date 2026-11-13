// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DownloadPage } from "./download-page";
import { CLI_COMMAND } from "./site";

describe("/download page", () => {
  it("lists the other computers apart from the phone apps", () => {
    const html = renderToStaticMarkup(<DownloadPage />);
    expect(html).toContain('href="/download/macos?placement=download_page"');
    const computers = html.slice(
      html.indexOf('class="dl-rows"'),
      html.indexOf('class="dl-h2"'),
    );
    expect(computers).not.toContain("/download/macos");
    expect(computers).toContain(
      'href="/download/windows?placement=download_page"',
    );
    expect(computers).toContain(
      'href="/download/linux?placement=download_page"',
    );
    expect(computers).toContain(CLI_COMMAND);
    expect(computers).not.toContain("dl-row-installer");
    const phones = html.slice(html.indexOf('class="dl-h2"'));
    expect(phones).toContain("testflight.apple.com");
    expect(phones).toContain("bb-android.apk");
    expect(html).toContain('class="install-note install-note-touch"');
    expect(html).toContain("install-send");
  });

  it("shows no note under the macOS button and tags the alpha installers", () => {
    const html = renderToStaticMarkup(<DownloadPage />);
    expect(html).not.toContain("install-note-desktop");
    expect(html).not.toContain("Apple Silicon");
    expect(html).toContain('<span class="dl-row-tag">Alpha</span>');
    expect(html).toContain('<span class="dl-row-tag">Alpha · AppImage</span>');
  });
});
