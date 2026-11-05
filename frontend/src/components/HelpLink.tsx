const docs = 'https://github.com/namankumarsahu/DevFlow_2/blob/codex/demo-lite-dockerfile/docs/';

export default function HelpLink({ topic, text, page = 'CREATE-PROJECT.md' }: { topic: string; text: string; page?: string }) {
  return <a href={docs + page} target="_blank" rel="noreferrer" title={text} aria-label={`Help: ${topic}`}
    className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-600 text-xs text-slate-400 hover:text-indigo-300">?</a>;
}
