import MDEditor from '@uiw/react-md-editor';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';

interface Props {
  source: string;
  className?: string;
  // Render single newlines as <br> (soft line breaks), matching what a
  // plain-text/pre-wrap div used to look like. Wanted for short, chat-style
  // text (so Shift+Enter in the composer still produces a visible line
  // break) but deliberately opt-in — turning it on for long AI-authored
  // markdown (summaries, study guides) would fragment prose that the model
  // wrapped across lines without a blank line between them.
  breaks?: boolean;
}

// Thin wrapper around MDEditor.Markdown that also renders LaTeX math
// ($...$ inline, $$...$$ block) via remark-math + rehype-katex. GFM support
// is preserved — react-markdown-preview always appends remark-gfm to
// whatever remarkPlugins are passed in, it never replaces them.
export function MathMarkdown({ source, className, breaks }: Props) {
  return (
    <MDEditor.Markdown
      source={source}
      className={className}
      remarkPlugins={breaks ? [remarkMath, remarkBreaks] : [remarkMath]}
      rehypePlugins={[rehypeKatex]}
    />
  );
}
