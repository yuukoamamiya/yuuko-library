import { compareByUploadDate, matches, type SearchEntry } from '../lib/search';
import { categoryLabel } from '../lib/categories';
async function init() {
  const search = document.querySelector<HTMLInputElement>('#book-search')!;
  const select = document.querySelector<HTMLSelectElement>('#category-select')!;
  const tag = document.querySelector<HTMLInputElement>('#tag-filter')!;
  const sort = document.querySelector<HTMLSelectElement>('#sort-order')!;
  const form = document.querySelector<HTMLFormElement>('.search-toolbar')!;
  const grid = document.querySelector<HTMLElement>('#book-grid')!;
  const cards = new Map([...grid.querySelectorAll<HTMLElement>('[data-book-id]')].map(card => [card.dataset.bookId!, card]));
  const buttons = document.querySelectorAll<HTMLButtonElement>('[data-category]');
  const count = document.querySelector<HTMLElement>('#result-count')!;
  const reset = document.querySelector<HTMLButtonElement>('#reset-filters')!;
  let entries: SearchEntry[];
  fromUrl(true);
  try {
    const response = await fetch('/search-index.json');
    if (!response.ok) throw new Error('索引加载失败');
    entries = await response.json();
  } catch { count.textContent = '搜索暂不可用，仍可浏览全部书籍。'; return; }
  function fromUrl(preserveTypedInput = false) {
    const params = new URLSearchParams(location.search);
    search.value = params.get('q') ?? (preserveTypedInput ? search.value : '');
    select.value = params.get('category') ?? '';
    tag.value = params.get('subject') ?? '';
    sort.value = ['default', 'title', 'author'].includes(params.get('sort') ?? '') ? params.get('sort')! : 'uploaded';
  }
  function render(updateUrl = true) {
    const query = search.value; const subject = tag.value.trim(); const category = select.value;
    const ordered = [...entries];
    if (sort.value === 'uploaded') ordered.sort(compareByUploadDate);
    else if (sort.value === 'title' || sort.value === 'author') ordered.sort((a, b) => (sort.value === 'title' ? a.title : a.authors.join(' ')).localeCompare(sort.value === 'title' ? b.title : b.authors.join(' '), 'zh-CN'));
    let total = 0;
    ordered.forEach(entry => {
      const card = cards.get(entry.id); if (!card) return;
      const visible = matches(entry, query, subject, category);
      card.hidden = !visible; if (visible) total++;
      grid.append(card);
    });
    count.textContent = query.trim() || subject || category ? `找到 ${total} 本书籍${category ? ` · ${categoryLabel(category)}` : ''}${subject ? ` · ${subject}` : ''}` : `共 ${total} 本书籍`;
    document.querySelector<HTMLElement>('#empty-state')!.hidden = total !== 0 || entries.length === 0;
    reset.hidden = !query && !subject && !category && sort.value === 'uploaded';
    buttons.forEach(button => { const active = button.dataset.category === category;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    if (updateUrl) {
      const url = new URL(location.href);
      for (const [key, value] of [['q', query], ['subject', subject], ['category', category], ['sort', sort.value === 'uploaded' ? '' : sort.value]]) {
        if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
      }
      history.replaceState(null, '', url);
    }
  }
  function clear() { search.value = ''; select.value = ''; tag.value = ''; sort.value = 'uploaded'; render(); }
  search.addEventListener('input', () => render());
  tag.addEventListener('input', () => render());
  select.addEventListener('change', () => render()); sort.addEventListener('change', () => render());
  form.addEventListener('submit', event => { event.preventDefault(); render(); });
  buttons.forEach(button => button.addEventListener('click', () => { select.value = button.dataset.category!; render(); }));
  reset.addEventListener('click', clear); document.querySelector('#empty-reset')!.addEventListener('click', clear);
  window.addEventListener('popstate', () => { fromUrl(); render(false); });
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) {
      event.preventDefault(); search.focus();
    }
  });
  render(false);
}
init();
