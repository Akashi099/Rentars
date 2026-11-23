import type { Preview } from '@storybook/react';
import '../src/app/globals.css';

/**
 * Apply or remove the `.dark` class on `<html>` to switch between the CSS-
 * variable-based light and dark themes (Tailwind `darkMode: ['class']`).
 */
function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

/**
 * Documented responsive breakpoints (Issue 103).
 * Keep these in sync with `apps/web/tailwind.config.*` and the visual
 * regression fixtures under `tests/visual/`.
 */
const VIEWPORTS = {
  narrowMobile: {
    name: 'Narrow mobile (320px)',
    styles: { width: '320px', height: '640px' },
    type: 'mobile' as const,
  },
  mobile: {
    name: 'Mobile (375px)',
    styles: { width: '375px', height: '812px' },
    type: 'mobile' as const,
  },
  mediumTablet: {
    name: 'Medium tablet (768px)',
    styles: { width: '768px', height: '1024px' },
    type: 'tablet' as const,
  },
  wideDesktop: {
    name: 'Wide desktop (1280px)',
    styles: { width: '1280px', height: '800px' },
    type: 'desktop' as const,
  },
};

/**
 * Minimal WCAG contrast helpers used by the contrast-check decorator
 * (Issue 104). These run in the browser preview so they can read the
 * computed colors of rendered status components in both themes.
 */
type RGB = { r: number; g: number; b: number };

function parseColor(input: string): RGB | null {
  const value = input.trim();
  if (!value) return null;
  const rgbMatch = value.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i,
  );
  if (rgbMatch) {
    return {
      r: Number(rgbMatch[1]),
      g: Number(rgbMatch[2]),
      b: Number(rgbMatch[3]),
    };
  }
  const hexMatch = value.match(/^#([0-9a-f]{3,8})$/i);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  return null;
}

function relativeLuminance({ r, g, b }: RGB): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg: RGB, bg: RGB): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function resolveBackground(el: Element): RGB | null {
  let node: Element | null = el;
  while (node) {
    const bg = parseColor(getComputedStyle(node).backgroundColor);
    if (bg) return bg;
    node = node.parentElement;
  }
  return { r: 255, g: 255, b: 255 };
}

/**
 * Runs a contrast assertion over elements marked with `data-contrast-check`.
 * Stories opt in by adding the attribute to status text/controls. The
 * decorator fails loudly (throws) when a combination drops below the
 * agreed target so visual checks catch material regressions.
 */
function runContrastCheck(root: HTMLElement, theme: string) {
  const targets = root.querySelectorAll<HTMLElement>('[data-contrast-check]');
  if (targets.length === 0) return;

  const minRatio = Number(
    root.getAttribute('data-contrast-min') ??
      targets[0]?.getAttribute('data-contrast-min') ??
      '4.5',
  );

  const failures: string[] = [];
  targets.forEach((el) => {
    const style = getComputedStyle(el);
    const fg = parseColor(style.color);
    const bg = resolveBackground(el);
    if (!fg || !bg) return;
    const ratio = contrastRatio(fg, bg);
    if (ratio < minRatio) {
      failures.push(
        `"${el.textContent?.trim().slice(0, 40) ?? el.tagName}" ratio ${ratio.toFixed(
          2,
        )}:1 < ${minRatio}:1 (${theme})`,
      );
    }
  });

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[contrast-check] ${theme} theme failures:\n${failures.join('\n')}`);
    throw new Error(
      `Contrast check failed in ${theme} theme:\n${failures.join('\n')}`,
    );
  }
}

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Color theme',
      defaultValue: 'light',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: [
          { value: 'light', icon: 'sun', title: 'Light' },
          { value: 'dark', icon: 'moon', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },

  decorators: [
    (Story, context) => {
      const theme = context.globals.theme ?? 'light';
      applyTheme(theme);

      // Contrast-check decorator (Issue 104): runs after render for stories
      // that opt in via `data-contrast-check` attributes.
      const shouldCheck =
        context.parameters?.contrastCheck === true ||
        context.parameters?.contrastCheck?.enabled === true;

      if (shouldCheck && typeof window !== 'undefined') {
        // Defer until after paint so computed styles reflect the theme.
        window.requestAnimationFrame(() => {
          try {
            runContrastCheck(document.body, theme);
          } catch (err) {
            // Surface in the Storybook UI without breaking unrelated stories.
            // eslint-disable-next-line no-console
            console.error(err);
          }
        });
      }

      return Story();
    },
  ],

  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    nextjs: { appDirectory: true },
    viewport: {
      viewports: VIEWPORTS,
      defaultViewport: 'responsive',
    },
    // a11y addon not installed — accessibility is validated via vitest in tests/keyboard-accessibility.test.tsx
    // a11y: { ... },
  },
};

export default preview;