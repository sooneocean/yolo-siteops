import { describe, expect, it } from 'vitest';
import {
  applyReconciliationTransform,
  isDoubleLfTransformEligible,
  matchingReconciliationTransforms,
} from '../apps/server/writer/transform-helper.js';

describe('reconciliation transform registry', () => {
  it('preserves the existing v1 output exactly', () => {
    const approved = '<p>A</p>\n<h2>B</h2>\n<p class="kept">C</p>';
    expect(applyReconciliationTransform('strip_bare_p_v1', approved)).toBe('A\n<h2>B</h2>\n<p class="kept">C');
  });

  it('applies the narrowly eligible double-LF transform byte for byte', () => {
    const approved = '<h2>Heading</h2>\n<p>Alpha <a href="https://example.test/">link</a></p>\n<ul><li>One</li></ul>';
    const actual = '<h2>Heading</h2>\n\nAlpha <a href="https://example.test/">link</a>\n\n<ul><li>One</li></ul>';
    expect(isDoubleLfTransformEligible(approved)).toBe(true);
    expect(applyReconciliationTransform('strip_bare_p_double_lf_v1', approved)).toBe(actual);
    expect(matchingReconciliationTransforms(approved, actual)).toEqual(['strip_bare_p_double_lf_v1']);
  });

  it.each([
    ['no LF', '<p>one</p>'],
    ['CRLF', '<p>one</p>\r\n<p>two</p>'],
    ['comment', '<p>one</p>\n<!-- comment -->'],
    ['root attributes', '<p class="x">one</p>\n<p>two</p>'],
    ['style attribute', '<p><span style="color:red">one</span></p>\n<p>two</p>'],
    ['pre', '<p><pre>one</pre></p>\n<p>two</p>'],
    ['code', '<p><code>one</code></p>\n<p>two</p>'],
    ['textarea', '<p><textarea>one</textarea></p>\n<p>two</p>'],
    ['blank root', '<p>one</p>\n\n<p>two</p>'],
    ['multiple roots', '<p>one</p><p>two</p>\n<p>three</p>'],
    ['outside text', 'x<p>one</p>\n<p>two</p>'],
    ['malformed nesting', '<p><strong>one</p></strong>\n<p>two</p>'],
    ['unclosed nesting', '<p><strong>one</p>\n<p>two</p>'],
  ])('rejects %s before considering the double-LF transform', (_label, approved) => {
    expect(isDoubleLfTransformEligible(approved)).toBe(false);
    expect(() => applyReconciliationTransform('strip_bare_p_double_lf_v1', approved)).toThrow('Unsupported reconciliation transform');
  });

  it.each([
    ['inline whitespace', 'One \n\nTwo'],
    ['link change', 'One <a href="https://other.test/">link</a>\n\nTwo'],
    ['attribute change', 'One\n\n<p class="x">Two</p>'],
  ])('does not match when actual content has an extra %s mutation', (_label, actual) => {
    const approved = '<p>One</p>\n<p>Two</p>';
    expect(matchingReconciliationTransforms(approved, actual)).toEqual([]);
  });

  it('selects only legacy v1 when WordPress preserved the original LF count', () => {
    expect(matchingReconciliationTransforms('<p>One</p>\n<p>Two</p>', 'One\nTwo')).toEqual(['strip_bare_p_v1']);
  });
});
