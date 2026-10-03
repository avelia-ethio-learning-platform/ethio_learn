import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';
import { TOKEN_PARENTS } from './redact';

/**
 * Source guards for Phase 9d. They catch the common mistakes, not every
 * possible leak: masking at the known sites (maskEmail, redactPath,
 * redactEmails) does the rest.
 */
const API_ROOT = join(__dirname, '../../../..');
const PII_NAME = /email|^to$|recipient/i;
/** `recipient_user_id`, `emailIds`: ids, not addresses. */
const ID_NAME = /(_id|Id)s?$/;
const LOG_CALL = /^(log|warn|error|debug|verbose|fatal)$/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

function scanned(): string[] {
  const services = join(API_ROOT, 'services');
  return [
    ...readdirSync(services).flatMap((s) => sources(join(services, s, 'src'))),
    ...sources(join(API_ROOT, 'gateway/src')),
  ];
}

/** True for `logger.warn(`, `this.logger.error(`, `Logger.log(`. */
function isLogCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !LOG_CALL.test(callee.name.text)) return false;
  const target = callee.expression;
  const name = ts.isPropertyAccessExpression(target) ? target.name.text : ts.isIdentifier(target) ? target.text : '';
  return /^logger$/i.test(name);
}

/** The identifier whose value ends up in the message: not a receiver (`this.email.name`), callee, key or parameter. */
function isLoggedValue(id: ts.Identifier): boolean {
  let expr: ts.Node = id;
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent)) {
    if (parent.expression === id) return false;
    expr = parent;
  }
  const outer = expr.parent;
  if (ts.isPropertyAccessExpression(outer) && outer.expression === expr) return false;
  if (ts.isCallExpression(outer) && outer.expression === expr) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (ts.isParameter(parent)) return false;
  return true;
}

function insideMaskEmail(node: ts.Node, stop: ts.Node): boolean {
  for (let n = node.parent; n && n !== stop; n = n.parent) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'maskEmail') return true;
  }
  return false;
}

/** `file:line` of every log call that logs an email-named value outside maskEmail(…). */
function piiInLogCalls(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLogCall(node)) {
      const check = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && PII_NAME.test(n.text) && !ID_NAME.test(n.text) && isLoggedValue(n) && !insideMaskEmail(n, node)) {
          found.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} logs \`${n.text}\``);
        }
        ts.forEachChild(n, check);
      };
      node.arguments.forEach(check);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Route params named like a credential whose parent segment isn't in TOKEN_PARENTS, so the access log would print them. */
function unredactedTokenRoutes(file: string, source: string): string[] {
  const prefix = /@Controller\(\s*'([^']*)'/.exec(source)?.[1] ?? '';
  const found: string[] = [];
  for (const match of source.matchAll(/@(Get|Post|Put|Patch|Delete|All)\(\s*'([^']*)'/g)) {
    const segments = `${prefix}/${match[2]}`.split('/').filter(Boolean);
    segments.forEach((segment, i) => {
      if (!/^:.*(token|secret)/i.test(segment)) return;
      if (!TOKEN_PARENTS.includes((segments[i - 1] ?? '').toLowerCase())) found.push(`${file}: @${match[1]}('${match[2]}')`);
    });
  }
  return found;
}

describe('no personal data in log calls', () => {
  it('flags a multi-line log call with an email-named value, in any case', () => {
    const source = [
      'class A {',
      '  run(customerEmail: string, dto: { email: string }, message: { to: string }) {',
      '    this.logger.warn(',
      '      `Chapa rejected ${customerEmail}; ` +',
      '        `retrying`,',
      '    );',
      '    Logger.log(`sent to ${message.to} and ${dto.email}`, "X");',
      '    this.logger.error({ recipient_email });',
      '  }',
      '}',
    ].join('\n');
    expect(piiInLogCalls('fixture.ts', source)).toEqual([
      'fixture.ts:4 logs `customerEmail`',
      'fixture.ts:7 logs `to`',
      'fixture.ts:7 logs `email`',
      'fixture.ts:8 logs `recipient_email`',
    ]);
  });

  it('passes the same values wrapped in maskEmail(…), and names that only look alike', () => {
    const source = [
      'this.logger.warn(',
      '  `Chapa rejected ${maskEmail(customerEmail)}; retrying`,',
      ');',
      'this.logger.error(`email failed via ${this.email.name} for ${recipients.length}: ${toLabel}`);',
      'this.logger.log(`total ${list.map((to) => 1).length}`);',
      'this.logger.log(`learner ${p.recipient_user_id}`);',
      'this.email.send({ to, subject });',
    ].join('\n');
    expect(piiInLogCalls('fixture.ts', source)).toEqual([]);
  });

  it('holds for every logger call in the services and the gateway', () => {
    const found = scanned().flatMap((file) => piiInLogCalls(relative(API_ROOT, file), readFileSync(file, 'utf8')));
    expect(found).toEqual([]);
  });
});

describe('token routes', () => {
  it('flags a credential param under a parent the access log does not redact', () => {
    const source = "@Controller('auth')\nclass C {\n  @Get('reset/:token')\n  a() {}\n  @Get('invite/:token')\n  b() {}\n}";
    expect(unredactedTokenRoutes('fixture.controller.ts', source)).toEqual(["fixture.controller.ts: @Get('reset/:token')"]);
  });

  it('holds for every controller', () => {
    const found = scanned()
      .filter((file) => file.endsWith('.controller.ts'))
      .flatMap((file) => unredactedTokenRoutes(relative(API_ROOT, file), readFileSync(file, 'utf8')));
    expect(found).toEqual([]);
  });
});
