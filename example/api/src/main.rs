use std::io::{Read, Write};
use std::net::TcpListener;

fn main() {
    let port = std::env::var("PORT").expect("PORT is required");
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).expect("bind");
    for stream in listener.incoming() {
        let mut stream = stream.expect("accept");
        let mut buf = [0; 1024];
        let _ = stream.read(&mut buf);
        let body = "ok";
        let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{}", body.len(), body);
    }
}
