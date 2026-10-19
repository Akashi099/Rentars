/**
 * Accessibility Manual Review Matrix
 *
 * For each critical flow, track manual testing across keyboard, zoom, screen reader, and contrast.
 * All critical items must PASS before release.
 *
 * To update: Set `date`, `passed: true|false`, and `notes` after testing.
 * Owner is responsible for test completion and sign-off.
 */

export interface A11yReviewItem {
  description: string;
  tester: string;
  date: string | null;
  passed: boolean | null;
  notes: string;
}

export interface A11yManualMatrix {
  [flowName: string]: {
    [checkName: string]: A11yReviewItem;
  };
}

export const accessibilityManualMatrix: A11yManualMatrix = {
  search: {
    keyboard: {
      description: 'All filters and sort controls operable via keyboard; Tab/Shift+Tab navigation works',
      tester: 'QA Lead',
      date: null,
      passed: null,
      notes: '',
    },
    zoom: {
      description: 'Search results and filters remain readable and usable at 200% zoom',
      tester: 'QA Lead',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description:
        'Filter categories, options, and result count announced; active filters indicated via aria-pressed',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
    contrast: {
      description: 'All filter labels and result text meet WCAG AA 4.5:1 contrast ratio',
      tester: 'Designer',
      date: null,
      passed: null,
      notes: '',
    },
  },

  booking_detail: {
    keyboard: {
      description:
        'All booking actions (confirm, message, cancel) and date pickers accessible without mouse',
      tester: 'QA Lead',
      date: null,
      passed: null,
      notes: '',
    },
    zoom: {
      description: 'Booking details (dates, price, address) readable at 200% zoom without horizontal scroll',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description:
        'Booking status, dates, and cancellation policy announced; buttons labeled with action text',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
    contrast: {
      description: 'Price amounts and status labels have sufficient contrast against backgrounds',
      tester: 'Designer',
      date: null,
      passed: null,
      notes: '',
    },
  },

  dashboard: {
    keyboard: {
      description: 'Tab through all dashboard cards and links; no keyboard trap; Escape closes modals',
      tester: 'QA Lead',
      date: null,
      passed: null,
      notes: '',
    },
    zoom: {
      description:
        'Dashboard sections stack properly at 200% zoom; no horizontal scroll for primary actions',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description:
        'Section headings announce role (tenant/host/admin); data tables use proper th/td semantics',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
    contrast: {
      description: 'Dashboard card headers and data labels meet WCAG AA contrast',
      tester: 'Designer',
      date: null,
      passed: null,
      notes: '',
    },
  },

  wallet: {
    keyboard: {
      description: 'Payment method selection and confirmation fully keyboard navigable',
      tester: 'Security QA',
      date: null,
      passed: null,
      notes: '',
    },
    zoom: {
      description: 'Currency amounts and payment status legible at 200% zoom',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description:
        'Payment method labels and balance amounts announced; transaction history read top-to-bottom',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
    contrast: {
      description: 'Balance numbers and transaction amounts have 4.5:1 contrast',
      tester: 'Designer',
      date: null,
      passed: null,
      notes: '',
    },
  },

  map: {
    keyboard: {
      description: 'Pan, zoom, and marker selection via arrow keys, +/-, and Enter; focus visible on markers',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    zoom: {
      description: 'Map remains usable at 200% zoom; marker labels readable',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description:
        'Map announced as landmark; property markers and counts announced; list alternative provided',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
    contrast: {
      description: 'Marker icons and labels have sufficient contrast against map background',
      tester: 'Designer',
      date: null,
      passed: null,
      notes: '',
    },
  },

  messages: {
    keyboard: {
      description: 'Message list navigation, compose, and send button all keyboard operable',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    zoom: {
      description: 'Message threads readable at 200% zoom without horizontal scroll',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description:
        'Message author, timestamp, and content announced in reading order; new message indicator polite',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
    contrast: {
      description: 'Sender names and timestamps have sufficient contrast',
      tester: 'Designer',
      date: null,
      passed: null,
      notes: '',
    },
  },

  modal: {
    keyboard: {
      description: 'Focus trapped in modal; Escape closes and restores focus; Tab cycles through fields',
      tester: 'QA Lead',
      date: null,
      passed: null,
      notes: '',
    },
    zoom: {
      description: 'Modal content readable at 200% zoom; close button always visible',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description: 'Modal announced with role=dialog; title linked via aria-labelledby',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
  },

  forms: {
    keyboard: {
      description: 'All form fields tab-accessible; required fields keyboard-indicated',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description: 'Labels associated with inputs via for/id; error messages linked via aria-describedby',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
    contrast: {
      description: 'Form labels and error messages meet WCAG AA contrast',
      tester: 'Designer',
      date: null,
      passed: null,
      notes: '',
    },
  },

  dataTable: {
    keyboard: {
      description:
        'Sort headers, pagination buttons, and row expand controls keyboard accessible; sort direction announced',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
    screenReader: {
      description: 'Table headers associated; row and column counts announced; sort state expressed',
      tester: 'Accessibility Specialist',
      date: null,
      passed: null,
      notes: '',
    },
    zoom: {
      description: 'Table scrolls horizontally on narrow zoom without hiding primary actions',
      tester: 'QA',
      date: null,
      passed: null,
      notes: '',
    },
  },
};

/**
 * Checklist for release gate.
 * All items marked `passed: true` required before shipping.
 */
export function getA11yReleaseGateStatus(): {
  totalChecks: number;
  passedChecks: number;
  blockedChecks: number;
  canRelease: boolean;
} {
  let totalChecks = 0;
  let passedChecks = 0;
  let blockedChecks = 0;

  Object.values(accessibilityManualMatrix).forEach(flow => {
    Object.values(flow).forEach(item => {
      totalChecks += 1;
      if (item.passed === true) {
        passedChecks += 1;
      } else if (item.passed === false) {
        blockedChecks += 1;
      }
    });
  });

  return {
    totalChecks,
    passedChecks,
    blockedChecks,
    canRelease: blockedChecks === 0 && passedChecks === totalChecks,
  };
}
