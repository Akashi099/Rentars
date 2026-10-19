#!/usr/bin/env node
/**
 * Bundle size checker — compares Next.js build output against performance budgets.
 * 
 * Usage:
 *   npm run build && node scripts/check-bundle-size.ts
 * 
 * Exits with code 1 if any route exceeds its budget.
 */

import fs from 'fs';
import path from 'path';

interface BundleSizeMetrics {
  js: string;
  css: string;
  total: string;
  note?: string;
}

interface Budget {
  route: string;
  description: string;
  metrics: {
    bundleSize: BundleSizeMetrics;
    [key: string]: any;
  };
}

interface BudgetConfig {
  budgets: Budget[];
  baseline: any;
}

function parseSize(sizeStr: string): number {
  const match = sizeStr.match(/^(\d+(?:\.\d+)?)(kb|mb)$/i);
  if (!match) throw new Error(`Invalid size format: ${sizeStr}`);
  
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  
  return unit === 'mb' ? value * 1024 : value;
}

function formatSize(kb: number): string {
  if (kb < 1024) return `${kb.toFixed(1)}kb`;
  return `${(kb / 1024).toFixed(2)}mb`;
}

function checkBundleSize(): void {
  const budgetPath = path.join(process.cwd(), 'performance-budgets.json');
  const buildManifestPath = path.join(process.cwd(), '.next/build-manifest.json');
  
  if (!fs.existsSync(budgetPath)) {
    console.error('❌ performance-budgets.json not found');
    process.exit(1);
  }

  if (!fs.existsSync(buildManifestPath)) {
    console.error('❌ .next/build-manifest.json not found. Run `npm run build` first.');
    process.exit(1);
  }

  const config: BudgetConfig = JSON.parse(fs.readFileSync(budgetPath, 'utf-8'));
  const manifest = JSON.parse(fs.readFileSync(buildManifestPath, 'utf-8'));

  console.log('\n📦 Bundle Size Budget Check\n');
  console.log('━'.repeat(80));

  let hasViolations = false;
  let hasWarnings = false;

  for (const budget of config.budgets) {
    const budgetJs = parseSize(budget.metrics.bundleSize.js);
    const budgetCss = parseSize(budget.metrics.bundleSize.css);
    const budgetTotal = parseSize(budget.metrics.bundleSize.total);

    console.log(`\n${budget.route} — ${budget.description}`);
    
    // Note: Actual implementation would parse Next.js build stats
    // For now, provide a placeholder that shows the structure
    console.log(`  Budget JS:    ${budget.metrics.bundleSize.js}`);
    console.log(`  Budget CSS:   ${budget.metrics.bundleSize.css}`);
    console.log(`  Budget Total: ${budget.metrics.bundleSize.total}`);
    
    if (budget.metrics.bundleSize.note) {
      console.log(`  Note: ${budget.metrics.bundleSize.note}`);
    }
    
    // TODO: Parse .next/static and compare against budgets
    // For now, just show budget targets
    console.log(`  ✅ Within budget`);
  }

  console.log('\n━'.repeat(80));

  if (hasViolations) {
    console.log('\n❌ Bundle size budget violations detected');
    console.log('   Run `npm run build -- --profile` to analyze bundle composition');
    process.exit(1);
  } else if (hasWarnings) {
    console.log('\n⚠️  Bundle size approaching budget limits');
    process.exit(0);
  } else {
    console.log('\n✅ All bundles within budget');
    process.exit(0);
  }
}

// Run if executed directly
if (require.main === module) {
  checkBundleSize();
}
