// Símbolos usados sem import no client (demanda #11, passo 4).
//
// A tela "Acessos" ficou PRETA em produção: `AdminFeatures.jsx` usava `<Link to=...>` sem
// importar o `Link` do react-router-dom. Um `ReferenceError` durante o render derruba a
// árvore INTEIRA do React — o usuário não perde uma tela, perde o sistema.
//
// Nada pegava isso:
//   - o `vite build` compila numa boa (um símbolo global indefinido só estoura em runtime);
//   - a suíte roda em `environment: 'node'`, sem jsdom — não renderizamos React.
//
// Então a trava é no FONTE, no espírito do `prompt-files.test.js`: se um `.jsx` usa um
// símbolo do router, ele tem que importá-lo no mesmo arquivo.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'client', 'src');

/** Todos os .jsx do client, recursivamente. */
function jsxFiles(dir = SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsxFiles(full, out);
    else if (entry.name.endsWith('.jsx')) out.push(full);
  }
  return out;
}

/**
 * Remove comentários e strings antes de procurar o uso.
 *
 * Sem isto, um `<Link>` citado num comentário ("o All_OS usava <Link>…") ou dentro de uma
 * string contaria como uso real e o teste acusaria um falso positivo — que é a forma mais
 * rápida de um teste destes ser desativado por irritação.
 */
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

// Símbolos do react-router-dom que já nos morderam ou morderiam do mesmo jeito.
const COMPONENTS = ['Link', 'NavLink', 'Navigate', 'Outlet', 'Routes', 'Route'];
const HOOKS = ['useNavigate', 'useParams', 'useLocation', 'useSearchParams'];

const FILES = jsxFiles();

describe('client: símbolos do router usados sem import', () => {
  it('encontra arquivos .jsx para analisar', () => {
    // Se o glob quebrar (rename de pasta), o teste passaria vazio — verde sem testar nada.
    expect(FILES.length).toBeGreaterThan(20);
  });

  it.each(FILES.map((f) => [path.relative(SRC, f), f]))('%s importa tudo o que usa', (_rel, file) => {
    const raw = fs.readFileSync(file, 'utf-8');
    const code = stripNoise(raw);

    const faltando = [];

    for (const sym of COMPONENTS) {
      // `<Link ` / `<Link>` / `<Link/>` — o espaço/fecho evita casar com <LinkPreview>.
      if (new RegExp(`<${sym}[\\s/>]`).test(code) && !importsSymbol(code, sym)) faltando.push(sym);
    }
    for (const sym of HOOKS) {
      if (new RegExp(`\\b${sym}\\s*\\(`).test(code) && !importsSymbol(code, sym)) faltando.push(sym);
    }

    expect(faltando, `${path.relative(SRC, file)} usa ${faltando.join(', ')} sem importar`).toEqual([]);
  });
});

/**
 * O símbolo está importado, definido localmente, ou recebido como prop desestruturada?
 *
 * Aceitamos as três formas porque o teste só quer saber se o identificador EXISTE no
 * escopo do módulo — não impor de onde ele vem.
 */
function importsSymbol(code, sym) {
  const b = `\\b${sym}\\b`;
  return (
    new RegExp(`import[\\s\\S]{0,200}?${b}[\\s\\S]{0,200}?from`).test(code) ||
    new RegExp(`(function|const|let|class)\\s+${sym}\\b`).test(code) ||
    new RegExp(`\\{[^{}]*${b}[^{}]*\\}\\s*=`).test(code)
  );
}
