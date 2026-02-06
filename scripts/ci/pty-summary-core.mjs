import path from 'path';

function toStringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function normalizePath(value) {
  return toStringOrEmpty(value).replace(/\\/g, '/');
}

function parseFailureMessage(message) {
  if (!message || typeof message !== 'string') return '';
  return message.trim();
}

function parseAssertions(testResult) {
  if (!testResult || !Array.isArray(testResult.assertionResults)) return [];

  const suitePath = normalizePath(testResult.name);
  const failures = [];
  for (const assertion of testResult.assertionResults) {
    if (assertion.status !== 'failed') continue;
    const title = toStringOrEmpty(assertion.title);
    const ancestors = Array.isArray(assertion.ancestorTitles)
      ? assertion.ancestorTitles.filter((x) => typeof x === 'string')
      : [];
    const fullName = [...ancestors, title].filter(Boolean).join(' > ');
    const failureMessages = Array.isArray(assertion.failureMessages)
      ? assertion.failureMessages.map(parseFailureMessage).filter(Boolean)
      : [];

    failures.push({
      title,
      fullName,
      suitePath,
      failureMessages,
    });
  }

  return failures;
}

export function parseVitestJson(input) {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    return {
      state: 'infra-error',
      totals: null,
      failures: [],
      reason: 'Unable to parse Vitest JSON output.',
    };
  }

  const totals = {
    total: Number(parsed.numTotalTests ?? 0),
    passed: Number(parsed.numPassedTests ?? 0),
    failed: Number(parsed.numFailedTests ?? 0),
    pending: Number(parsed.numPendingTests ?? 0),
  };

  let state = 'passed';
  if (totals.failed > 0) {
    state = 'failed';
  } else if (totals.total === 0) {
    state = 'no-tests-collected';
  } else if (totals.pending > 0 && totals.passed === 0) {
    state = 'skipped-env';
  }

  const failures = Array.isArray(parsed.testResults)
    ? parsed.testResults.flatMap(parseAssertions)
    : [];

  return {
    state,
    totals,
    failures,
    reason: null,
  };
}

export function pickTranscriptForFailure(failure, transcripts) {
  const exactByName = transcripts.find(
    (item) => item.testName && item.testName === failure.fullName
  );
  if (exactByName) return exactByName;

  const suffixByName = transcripts.find(
    (item) => item.testName && item.testName.endsWith(failure.title)
  );
  if (suffixByName) return suffixByName;

  const suitePath = normalizePath(failure.suitePath);
  const byPath = transcripts.find((item) =>
    item.testPath ? normalizePath(item.testPath).endsWith(path.basename(suitePath)) : false
  );
  if (byPath) return byPath;

  return null;
}

export function buildDigest(parsedResult, transcripts, transcriptPreviewLines = 12) {
  const previewLines = Number.isFinite(transcriptPreviewLines)
    ? Math.max(1, Math.floor(transcriptPreviewLines))
    : 12;

  const failures = parsedResult.failures.map((failure) => {
    const transcript = pickTranscriptForFailure(failure, transcripts);
    return {
      ...failure,
      transcript,
      transcriptPreview: transcript
        ? transcript.preview.slice(-previewLines)
        : [],
    };
  });

  return {
    state: parsedResult.state,
    totals: parsedResult.totals,
    reason: parsedResult.reason,
    failures,
    transcriptCount: transcripts.length,
  };
}

export function renderDigest(digest) {
  const lines = [];
  lines.push('=== PTY CI Digest ===');
  lines.push(`state: ${digest.state}`);

  if (digest.totals) {
    lines.push(
      `totals: total=${digest.totals.total} passed=${digest.totals.passed} failed=${digest.totals.failed} pending=${digest.totals.pending}`
    );
  }

  lines.push(`transcripts: ${digest.transcriptCount}`);

  if (digest.reason) {
    lines.push(`reason: ${digest.reason}`);
  }

  if (digest.failures.length === 0) {
    if (digest.state === 'failed') {
      lines.push('failures: reported by Vitest, but no assertion details were parsed');
    } else {
      lines.push('failures: none');
    }
    return lines.join('\n');
  }

  lines.push(`failures: ${digest.failures.length}`);
  for (const [idx, failure] of digest.failures.entries()) {
    lines.push(`\n[${idx + 1}] ${failure.fullName || failure.title || '(unknown test)'}`);
    if (failure.suitePath) {
      lines.push(`suite: ${failure.suitePath}`);
    }
    if (failure.failureMessages.length > 0) {
      lines.push('error:');
      lines.push(`  ${failure.failureMessages[0].split('\n')[0]}`);
    }
    if (failure.transcript) {
      lines.push(`transcript: ${failure.transcript.logFile}`);
      if (failure.transcriptPreview.length > 0) {
        lines.push('transcript tail:');
        for (const line of failure.transcriptPreview) {
          lines.push(`  ${line}`);
        }
      }
    } else {
      lines.push('transcript: (not mapped)');
    }
  }

  return lines.join('\n');
}
