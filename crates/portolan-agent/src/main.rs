use futures_util::{SinkExt, StreamExt};
use portolan_agent::{build_agent_url, handle_server_frame, parse_args, AgentCommand, AgentConfig};
use portolan_agent_protocol::{AgentFrame, AgentSessionsUpdatePayload};
use std::{env, process};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::main]
async fn main() {
    let command = match parse_args(env::args_os().skip(1)) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("{error}");
            process::exit(2);
        }
    };

    match command {
        AgentCommand::Connect(config) => run_connect_loop(config).await,
        AgentCommand::Status => {
            println!(
                "rust portolan-agent preview installed; Node server/agent.js remains authoritative"
            );
        }
    }
}

async fn run_connect_loop(config: AgentConfig) {
    loop {
        match connect_once(&config).await {
            Ok(()) if config.once => return,
            Ok(()) => {}
            Err(error) => eprintln!("[portolan-agent-rust] {error}"),
        }

        if config.once {
            process::exit(1);
        }
        tokio::time::sleep(config.reconnect_interval).await;
    }
}

async fn connect_once(config: &AgentConfig) -> Result<(), String> {
    let url = build_agent_url(config);
    eprintln!("[portolan-agent-rust] connecting to {url}");
    let (stream, _) = connect_async(&url)
        .await
        .map_err(|error| format!("connect failed: {error}"))?;
    let (mut write, mut read) = stream.split();

    let sessions = AgentFrame::AgentSessionsUpdate {
        payload: AgentSessionsUpdatePayload { sessions: vec![] },
    };
    write
        .send(Message::Text(sessions.to_json_string().map_err(
            |error| format!("encode sessions frame failed: {error}"),
        )?))
        .await
        .map_err(|error| format!("send sessions frame failed: {error}"))?;

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => return Ok(()),
            maybe_message = read.next() => {
                let Some(message) = maybe_message else { return Ok(()); };
                let message = message.map_err(|error| format!("websocket read failed: {error}"))?;
                match message {
                    Message::Text(text) => handle_text_frame(&mut write, text).await?,
                    Message::Binary(bytes) => handle_binary_frame(&mut write, bytes).await?,
                    Message::Close(_) => return Ok(()),
                    Message::Ping(bytes) => write.send(Message::Pong(bytes)).await.map_err(|error| format!("send pong failed: {error}"))?,
                    Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    }
}

async fn handle_text_frame<W>(write: &mut W, text: String) -> Result<(), String>
where
    W: futures_util::Sink<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    let frame = AgentFrame::parse(text.as_bytes())
        .map_err(|error| format!("parse server frame failed: {error}"))?;
    send_responses(write, handle_server_frame(&frame)).await
}

async fn handle_binary_frame<W>(write: &mut W, bytes: Vec<u8>) -> Result<(), String>
where
    W: futures_util::Sink<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    let frame =
        AgentFrame::parse(bytes).map_err(|error| format!("parse server frame failed: {error}"))?;
    send_responses(write, handle_server_frame(&frame)).await
}

async fn send_responses<W>(write: &mut W, responses: Vec<AgentFrame>) -> Result<(), String>
where
    W: futures_util::Sink<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    for response in responses {
        write
            .send(Message::Text(response.to_json_string().map_err(
                |error| format!("encode response failed: {error}"),
            )?))
            .await
            .map_err(|error| format!("send response failed: {error}"))?;
    }
    Ok(())
}
