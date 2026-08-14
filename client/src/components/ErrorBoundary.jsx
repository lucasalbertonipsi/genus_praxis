// Rede de segurança de renderização (demanda #11, passo 3).
//
// POR QUE ISTO EXISTE: a tela "Acessos" ficou PRETA em produção porque o `AdminFeatures`
// usava `<Link>` sem importar o símbolo. Um `ReferenceError` durante o render não é
// tratado pelo React — ele desmonta a árvore INTEIRA. O usuário não via um erro naquela
// tela: via o sistema inteiro sumir, sem mensagem, sem sidebar, sem saída.
//
// O `vite build` não pega essa classe de bug (um símbolo global indefinido só estoura em
// runtime) e a suíte não renderiza React. Então a defesa é esta: transformar um bug de UMA
// tela num incidente de UMA tela.
//
// ⚠ Só captura erros de RENDERIZAÇÃO. Uma exceção dentro de um `onClick`, de um `setTimeout`
// ou de uma promise rejeitada NÃO passa por aqui — é uma limitação do React, não uma
// escolha nossa. Por isso o boundary não substitui o tratamento de erro das telas.
import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // O console é a única trilha que temos em produção (não há telemetria no projeto).
    console.error('[ErrorBoundary] Erro ao renderizar a tela:', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    // Sem isto o boundary vira uma armadilha: uma vez em erro, ele continuaria mostrando a
    // tela de falha mesmo depois de o usuário navegar para outra rota — porque o estado do
    // componente sobrevive à troca de filhos. O `resetKey` (a rota atual) limpa o erro
    // quando o usuário sai da tela quebrada.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="error-boundary">
        <h2>Algo deu errado nesta tela</h2>
        <p>
          O restante do sistema continua funcionando — use o menu para ir para outra área.
          Se o problema se repetir, avise o administrador.
        </p>
        <p className="error-boundary-detail">{String(this.state.error?.message || this.state.error)}</p>
        <div className="error-boundary-actions">
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Tentar novamente
          </button>
          <button className="btn btn-secondary" onClick={() => window.location.reload()}>
            Recarregar a página
          </button>
        </div>
      </div>
    );
  }
}
