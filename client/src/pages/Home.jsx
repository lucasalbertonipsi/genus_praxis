import { useNavigate } from 'react-router-dom';
import Typewriter from '../components/Typewriter';

const STEPS = [
  {
    n: '01',
    title: 'Escolha um cliente',
    text: 'Na aba Simulação você encontra a biblioteca de clientes simulados. Cada card traz nome, idade e uma breve apresentação do caso.',
  },
  {
    n: '02',
    title: 'Conduza o atendimento',
    text: 'O cliente abre a conversa. Responda por mensagens, como numa sessão real — praticando escuta, manejo do vínculo e ritmo. Você pode enviar por texto ou gravar áudio (transcrição automática).',
  },
  {
    n: '03',
    title: 'Avance as sessões',
    text: 'Use "Próxima sessão" para pular o tempo até o próximo encontro — o cliente retorna na semana seguinte. Um cronômetro acompanha o tempo de cada atendimento.',
  },
  {
    n: '04',
    title: 'Finalize e envie',
    text: 'Ao encerrar, o log completo do atendimento é registrado no seu histórico e enviado para análise. Você recebe a confirmação na hora.',
  },
];

export default function Home({ user }) {
  const navigate = useNavigate();
  return (
    <div>
      {/* O banner inteiro é o link de captação (o "CLIQUE AQUI" faz parte da imagem, não é
          um elemento próprio). Abre em nova aba: sair do Praxis no meio de um atendimento
          faria o aluno perder a tela. `rel="noopener"` é obrigatório com target=_blank —
          sem ele a página de destino ganha acesso à nossa aba via `window.opener`. */}
      <a
        className="home-banner"
        href="https://omnia.lucasalbertoni.com/"
        target="_blank"
        rel="noopener noreferrer"
      >
        <img src={`${import.meta.env.BASE_URL}banner.jpeg`} alt="OMNIA Formação ACP — inscreva-se" />
      </a>

      <section className="home-hero">
        <div className="eyebrow">Bem-vindo(a), {user?.name?.split(' ')[0] || 'terapeuta'}</div>
        <h2>
          <Typewriter text="Simulação " />
          <span className="accent"><Typewriter text="Clínica" delayStart={420} /></span>
        </h2>
        <p className="home-hero-lead">
          Aqui você pratica atendimento com clientes simulados por IA. Um espaço seguro para
          treinar escuta, presença e condução — no seu ritmo, quantas sessões precisar.
        </p>
        <div className="ornament" />
        <button className="btn btn-primary btn-lg home-cta" onClick={() => navigate('/freeplay')}>
          Jogar simulação →
        </button>
      </section>

      <section className="home-steps" aria-label="Como funciona">
        <div className="home-steps-header">
          <div className="home-about-eyebrow">Como funciona</div>
          <h3 className="home-about-title">Quatro passos</h3>
        </div>
        <div className="steps-grid">
          {STEPS.map((s) => (
            <div className="step-card" key={s.n}>
              <div className="step-n">{s.n}</div>
              <h4>{s.title}</h4>
              <p>{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="home-footer-cta">
        <div>
          <div className="home-footer-cta-title">Pronto para começar?</div>
          <div className="home-footer-cta-sub">Escolha um cliente e inicie o seu primeiro atendimento.</div>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/freeplay')}>Ir para a Simulação</button>
      </div>
    </div>
  );
}
