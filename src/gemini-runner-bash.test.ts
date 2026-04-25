/**
 * Security tests for the Gemini bash tool's command validator.
 * The validator is the only thing standing between an LLM-generated command
 * and shell execution on the Pi, so injection vectors here matter.
 */
import { describe, it, expect } from 'vitest';

import { checkBashCommand } from './gemini-runner.js';

describe('checkBashCommand — allowed commands', () => {
  it('allows curl', () => {
    expect(checkBashCommand('curl -sL https://example.com')).toBeNull();
  });

  it('allows markitdown', () => {
    expect(checkBashCommand('markitdown file.pdf')).toBeNull();
  });

  it('allows pipe chains where every segment is allowed', () => {
    expect(
      checkBashCommand('curl -sL https://x.com | markitdown -x html'),
    ).toBeNull();
  });

  it('allows && chains where every segment is allowed', () => {
    expect(
      checkBashCommand(
        'curl -sL https://x.com -o /tmp/in.pdf && markitdown /tmp/in.pdf',
      ),
    ).toBeNull();
  });

  it('allows file listing commands', () => {
    expect(checkBashCommand('ls -la')).toBeNull();
    expect(checkBashCommand('find . -name "*.md"')).toBeNull();
  });
});

describe('checkBashCommand — disallowed commands', () => {
  it('rejects rm', () => {
    expect(checkBashCommand('rm -rf /tmp/data')).toMatch(/not allowed/);
  });

  it('rejects sudo', () => {
    expect(checkBashCommand('sudo apt update')).toMatch(/not allowed/);
  });

  it('rejects bash itself', () => {
    expect(checkBashCommand('bash -c "echo pwned"')).toMatch(/not allowed/);
  });

  it('rejects unknown commands', () => {
    expect(checkBashCommand('mysterious-binary --flag')).toMatch(/not allowed/);
  });
});

describe('checkBashCommand — semicolon injection (the original bug)', () => {
  it('blocks semicolon-chained rm even after an allowed first command', () => {
    // Pre-fix this would slip through: split('|', '&&') saw the whole string
    // as one segment, first word "curl" was allowed, and the shell then ran
    // `; rm -rf /` afterward.
    expect(checkBashCommand('curl https://x.com ; rm -rf /tmp')).toMatch(
      /not allowed/,
    );
  });

  it('blocks semicolon without spaces', () => {
    expect(checkBashCommand('curl https://x.com;rm /tmp/foo')).toMatch(
      /not allowed/,
    );
  });

  it('blocks chained allowed-then-disallowed via newline', () => {
    expect(checkBashCommand('ls -la\nrm -rf /tmp')).toMatch(/not allowed/);
  });

  it('blocks single-& backgrounding to a disallowed command', () => {
    expect(checkBashCommand('curl https://x.com & rm /tmp/foo')).toMatch(
      /not allowed/,
    );
  });
});

describe('checkBashCommand — command substitution', () => {
  it('blocks $() substitution', () => {
    expect(checkBashCommand('curl $(cat /etc/passwd)')).toMatch(/substitution/);
  });

  it('blocks backtick substitution', () => {
    expect(checkBashCommand('curl `cat /etc/passwd`')).toMatch(/substitution/);
  });
});

describe('checkBashCommand — redirect operators', () => {
  it('blocks output redirect with >', () => {
    expect(checkBashCommand('echo pwned > /tmp/file')).toMatch(/redirects/);
  });

  it('blocks append redirect with >>', () => {
    expect(checkBashCommand('echo line >> /tmp/file')).toMatch(/redirects/);
  });

  it('blocks input redirect with <', () => {
    expect(checkBashCommand('grep secret < /etc/passwd')).toMatch(/redirects/);
  });

  it('blocks heredoc with <<', () => {
    expect(checkBashCommand('cat << EOF')).toMatch(/redirects/);
  });

  it('blocks stderr redirect 2>', () => {
    expect(checkBashCommand('curl https://x.com 2> /tmp/err')).toMatch(
      /redirects/,
    );
  });

  it('blocks combined redirect &>', () => {
    expect(checkBashCommand('curl https://x.com &> /tmp/all')).toMatch(
      /redirects/,
    );
  });

  it('does NOT block curl -o (a flag, not a redirect)', () => {
    expect(
      checkBashCommand('curl -sL https://x.com -o /tmp/out.pdf'),
    ).toBeNull();
  });
});

describe('checkBashCommand — whitespace and edge cases', () => {
  it('handles leading/trailing whitespace', () => {
    expect(checkBashCommand('   ls   ')).toBeNull();
  });

  it('handles empty string (no allowed command found, but no segments either)', () => {
    expect(checkBashCommand('')).toBeNull();
  });

  it('case-insensitive matching of disallowed commands', () => {
    // The validator lowercases the first word; uppercase RM is still rm
    expect(checkBashCommand('RM -rf /tmp')).toMatch(/not allowed/);
  });
});
