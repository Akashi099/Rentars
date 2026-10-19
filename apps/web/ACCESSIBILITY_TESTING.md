# Accessibility Testing Guide

This document outlines the accessibility testing requirements and procedures for the Rentars web application.

## Overview

We implement a two-tier accessibility strategy:
1. **Automated tests** - Run in CI on every PR to catch common issues
2. **Manual review matrix** - Tracked in `src/tests/a11y-manual-matrix.ts` for flows requiring human validation

## Automated Tests

### Running Automated Tests

```bash
cd apps/web
yarn test a11y-critical-routes --run
```

### What's Tested Automatically

- **WCAG violations** detected by axe-core
- **Heading hierarchy** - Proper h1-h6 structure
- **Form labels** - All inputs have associated labels
- **Landmark regions** - Proper use of main, nav, etc.
- **Image alt text** - All images have descriptive alt attributes
- **Table semantics** - Proper use of th, scope, etc.
- **Button labels** - All interactive elements have clear labels
- **Dialog roles** - Modals use proper ARIA attributes
- **Focus indicators** - Visible focus states on interactive elements

### Critical Routes Covered

- Search page
- Property detail page
- Booking flow
- Dashboard (tenant, host, admin)
- Wallet & payment interfaces
- Modals and forms

## Manual Review Matrix

### Purpose

Some accessibility requirements cannot be automated and require manual testing:
- Keyboard navigation flows
- Screen reader announcements
- Zoom/magnification usability
- Real-world interaction patterns

### Location

The manual review matrix is maintained in:
```
apps/web/src/tests/a11y-manual-matrix.ts
```

### Flows Requiring Manual Review

1. **Search** - Filters, sort controls, keyboard navigation
2. **Booking Detail** - Date pickers, cancellation actions
3. **Dashboard** - Data tables, role-based navigation
4. **Wallet** - Payment methods, transaction history
5. **Map** - Keyboard pan/zoom, marker selection
6. **Messages** - Compose, send, thread navigation
7. **Modals** - Focus trap, escape key, focus restoration
8. **Forms** - Required field indicators, error messages
9. **Data Tables** - Sort controls, pagination, row expansion

### Manual Testing Requirements

For each flow, the following must be validated:

#### Keyboard Testing
- [ ] Tab/Shift+Tab cycles through interactive elements
- [ ] Enter/Space activates buttons and links
- [ ] Arrow keys work in dropdowns and date pickers
- [ ] Escape closes modals and cancels operations
- [ ] No keyboard traps exist
- [ ] Focus order is logical

#### Zoom Testing (200%)
- [ ] All content readable without horizontal scroll
- [ ] Interactive elements remain accessible
- [ ] No content clipped or hidden
- [ ] Layout doesn't break

#### Screen Reader Testing
- [ ] Headings announce page structure
- [ ] Form labels announce field purpose
- [ ] Error messages linked to fields via aria-describedby
- [ ] Button actions clearly announced
- [ ] Status changes announced via aria-live
- [ ] Tables announce headers and relationships

#### Contrast Testing
- [ ] Text meets WCAG AA 4.5:1 ratio
- [ ] Interactive elements meet 3:1 ratio
- [ ] Focus indicators are visible
- [ ] Status colors are distinguishable

### Updating the Matrix

After completing manual tests, update the matrix:

```typescript
export const accessibilityManualMatrix: A11yManualMatrix = {
  search: {
    keyboard: {
      description: 'All filters and sort controls operable via keyboard',
      tester: 'Your Name',
      date: '2024-01-15',  // Today's date
      passed: true,        // true if passed, false if failed, null if not tested
      notes: 'Tested with NVDA on Firefox',
    },
    // ... other checks
  },
};
```

### Release Gate

Before release, check the matrix status:

```bash
cd apps/web
node -e "
const { getA11yReleaseGateStatus } = require('./src/tests/a11y-manual-matrix.ts');
const status = getA11yReleaseGateStatus();
console.log('Can release:', status.canRelease);
console.log('Blocked checks:', status.blockedChecks);
"
```

**Release is blocked if**:
- Any check has `passed: false`
- Critical checks are incomplete (`passed: null`)

## Tools

### Automated Testing
- **axe-core** - WCAG violation detection
- **jest-axe** - Jest integration for axe-core
- **vitest** - Test runner

### Manual Testing
- **NVDA** (Windows) - Free screen reader
- **JAWS** (Windows) - Commercial screen reader
- **VoiceOver** (macOS/iOS) - Built-in screen reader
- **TalkBack** (Android) - Built-in screen reader
- **axe DevTools** - Browser extension for manual audits
- **WAVE** - Browser extension for visual feedback
- **Color Contrast Analyzer** - Desktop app for contrast checking

## Testing Workflows

### For Developers

1. Write component code
2. Add Storybook stories for all states
3. Run automated a11y tests
4. Fix any violations
5. Document any manual testing needs

### For QA Team

1. Review manual review matrix
2. Execute keyboard navigation tests
3. Test at 200% zoom
4. Validate with screen reader
5. Check color contrast
6. Update matrix with results

### For Release Manager

1. Run automated tests in CI
2. Check manual review matrix status
3. Verify all critical flows passed
4. Document any known exceptions
5. Approve or block release

## Common Issues and Fixes

### Missing Form Labels
```tsx
// ❌ Bad
<input type="text" placeholder="Name" />

// ✅ Good
<Label htmlFor="name">Name</Label>
<Input id="name" placeholder="Enter your name" />
```

### Missing Button Labels
```tsx
// ❌ Bad
<button><X /></button>

// ✅ Good
<button aria-label="Close modal"><X /></button>
```

### Improper Heading Hierarchy
```tsx
// ❌ Bad
<h1>Page Title</h1>
<h3>Section</h3>

// ✅ Good
<h1>Page Title</h1>
<h2>Section</h2>
```

### No Focus Indicators
```css
/* ❌ Bad */
button:focus {
  outline: none;
}

/* ✅ Good */
button:focus-visible {
  outline: 2px solid blue;
  outline-offset: 2px;
}
```

### Poor Color Contrast
```tsx
// ❌ Bad - Contrast ratio 2.5:1
<p className="text-gray-400">Important text</p>

// ✅ Good - Contrast ratio 7:1
<p className="text-gray-900 dark:text-gray-100">Important text</p>
```

## Resources

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [axe-core Rule Descriptions](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md)
- [MDN Accessibility Guide](https://developer.mozilla.org/en-US/docs/Web/Accessibility)
- [WebAIM Resources](https://webaim.org/resources/)

## Support

For accessibility questions or issues:
- Create an issue with the `accessibility` label
- Tag the QA Lead or Accessibility Specialist
- Reference this guide and the specific flow being tested
