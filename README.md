# 🌌 NeonGrid 2D — Multiplayer Collaborative Universe

Bem-vindo ao **NeonGrid 2D**, um universo multiplayer 2D colaborativo de estética cyber-neon premium. O projeto foi projetado com arquitetura de alta performance, utilizando um servidor leve em **Go** com WebSockets para sincronização de estados e voz P2P em tempo real via **WebRTC**.

---

## 🚀 Funcionalidades Principais

*   **Mundo Colaborativo 2D**: Mova-se pelo grid luminoso e interaja com outros jogadores em tempo real usando `WASD` ou as setas direcionais.
*   **Identidade Personalizada**: Escolha seu nickname e uma cor neon customizada para brilhar no mapa.
*   **Avatares Dinâmicos**: Insira qualquer link de imagem para usá-la de avatar. A imagem é renderizada com efeitos de física cartoon de salto (*hopping*) ao se mover e respiração (*breathing*) ao ficar inativo.
*   **Balões de Chat Flutuantes**: Digite mensagens no console lateral e veja as bolhas de chat aparecerem dinamicamente e flutuarem acima da cabeça do seu personagem com suavidade.
*   **Voice Chat P2P (WebRTC)**: Ative seu microfone diretamente no HUD do jogo para falar em tempo real com os jogadores conectados.
*   **Indicador Visual de Voz**: Quando um jogador fala, seu indicador de nome brilha em neon verde e um ícone de microfone animado surge acima dele.

---

## 🛠️ Arquitetura e Tecnologias

O sistema foi estruturado visando mínima latência e baixo consumo de recursos:

1.  **Backend (Go)**:
    *   Gerenciador de conexões via `github.com/gorilla/websocket`.
    *   Servidor HTTP nativo para servir arquivos estáticos e gerenciar o fluxo do WebSocket.
    *   Roteamento automático de sinalização WebRTC (SDP offers, answers e ICE candidates) entre pares de forma direta e segura.
2.  **Frontend (Vanilla JS + HTML5 Canvas + CSS)**:
    *   Renderização de alta performance rodando diretamente sob `requestAnimationFrame`.
    *   Detecção de voz local utilizando a **Web Audio API** do navegador (evitando sobrecarga do WebSocket com pacotes de volume).
    *   Pilha de conexões P2P dinâmicas para voz sem necessidade de servidores de mídia intermediários (SFU/MCU).
3.  **Ambiente Isolado (Docker)**:
    *   Build multi-stage para gerar uma imagem Alpine extremamente leve (menos de 20MB).

---

## 💻 Como Executar o Projeto

Você pode rodar o projeto de duas formas: nativamente com Go instalado ou através de contêineres Docker.

### Método 1: Utilizando Docker Compose (Recomendado para VPS e Produção)

Certifique-se de ter o [Docker](https://www.docker.com/) instalado em sua máquina.

1.  No diretório raiz do projeto, execute:
    ```bash
    docker compose up -d --build
    ```
2.  O contêiner será compilado e executado em segundo plano.
3.  Acesse pelo navegador em:
    *   Local: `http://localhost/`
    *   VPS: `http://<ip-da-vps>/`

**Comandos Úteis:**
*   Ver logs do servidor: `docker compose logs -f`
*   Parar a execução: `docker compose down`

---

### Método 2: Execução Local Nativa (Desenvolvimento)

Certifique-se de ter o [Go](https://go.dev/) (versão 1.22 ou superior) instalado.

1.  Instale as dependências de Go:
    ```bash
    go mod download
    ```
2.  Execute o servidor de desenvolvimento:
    ```bash
    go run main.go
    ```
3.  O servidor iniciará na porta `8080`.
4.  Abra seu navegador em: `http://localhost:8080/`

---

## 📁 Estrutura de Pastas

*   `main.go`: Ponto de entrada do servidor backend Go. Gerencia as rotas e conexões de rede WebSocket.
*   `Dockerfile`: Configuração de build de multi-estágio otimizada.
*   `docker-compose.yml`: Orquestração de contêiner para implantação simples.
*   `static/`: Contém os recursos do frontend do jogo:
    *   `index.html`: Estrutura base da tela de lobby e tela do canvas.
    *   `style.css`: Estilização cyber-neon com efeitos de glassmorphism e glows.
    *   `game.js`: Arquivo principal da lógica do cliente, loop de renderização, lógica de WebRTC e animações.

---

## 🔒 Requisito Importante para WebRTC (Voice Chat)

> [!IMPORTANT]
> Os navegadores modernos restringem o acesso ao microfone apenas a conexões seguras (`HTTPS`) ou servidores locais (`localhost`). 
> Ao publicar o jogo em uma VPS pública, certifique-se de configurar um proxy reverso (como Nginx ou Caddy) com suporte a SSL/HTTPS e WSS para que os jogadores possam utilizar o sistema de chat de voz por microfone.
