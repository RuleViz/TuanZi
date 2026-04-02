//! framing.rs — JSON-RPC Content-Length frame parser.
//!
//! Supports both Content-Length framed payloads and line-delimited JSON,
//! matching the MCP 2024-11-05 spec and common server behaviour.

/// Attempt to extract the next complete payload from `buffer`.
///
/// Returns `Some((payload_str, bytes_consumed))` on success,
/// `None` if more data is needed.
pub fn try_extract_frame(buffer: &[u8]) -> Option<(String, usize)> {
    // 1) Try Content-Length framing
    if let Some(result) = try_content_length_frame(buffer) {
        return Some(result);
    }

    // 2) Fall back to line-delimited JSON
    try_line_delimited(buffer)
}

fn try_content_length_frame(buffer: &[u8]) -> Option<(String, usize)> {
    let text = std::str::from_utf8(buffer).ok()?;

    // Look for header delimiter
    let (header_end, body_start) = if let Some(pos) = text.find("\r\n\r\n") {
        (pos, pos + 4)
    } else if let Some(pos) = text.find("\n\n") {
        (pos, pos + 2)
    } else {
        // Check if it looks like an incomplete header
        let lower = text[..text.len().min(64)].to_lowercase();
        if lower.starts_with("content-length") || lower.starts_with("content-type") {
            return None; // Need more data
        }
        return None;
    };

    let header = &text[..header_end];
    let cl = parse_content_length(header)?;

    if buffer.len() < body_start + cl {
        return None; // Need more data
    }

    let body = &text[body_start..body_start + cl];
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Some((String::new(), body_start + cl));
    }
    Some((trimmed.to_string(), body_start + cl))
}

fn try_line_delimited(buffer: &[u8]) -> Option<(String, usize)> {
    let text = std::str::from_utf8(buffer).ok()?;
    let newline_idx = text.find('\n')?;
    let line = text[..newline_idx].trim();
    let consumed = newline_idx + 1;

    if line.is_empty() {
        return Some((String::new(), consumed));
    }
    Some((line.to_string(), consumed))
}

fn parse_content_length(header: &str) -> Option<usize> {
    for line in header.lines() {
        let lower = line.to_lowercase();
        if lower.starts_with("content-length") {
            let parts: Vec<&str> = line.splitn(2, ':').collect();
            if parts.len() == 2 {
                if let Ok(n) = parts[1].trim().parse::<usize>() {
                    return Some(n);
                }
            }
        }
    }
    None
}

/// Format a JSON-RPC payload with Content-Length framing.
pub fn frame_message(body: &str) -> Vec<u8> {
    let byte_len = body.len();
    format!("Content-Length: {byte_len}\r\n\r\n{body}").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_content_length_frame() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let frame = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
        let result = try_extract_frame(frame.as_bytes());
        assert!(result.is_some());
        let (payload, consumed) = result.unwrap();
        assert_eq!(payload, body);
        assert_eq!(consumed, frame.len());
    }

    #[test]
    fn test_incomplete_frame() {
        let frame = b"Content-Length: 100\r\n\r\n{\"partial";
        assert!(try_extract_frame(frame).is_none());
    }

    #[test]
    fn test_line_delimited() {
        let line = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n";
        let result = try_extract_frame(line.as_bytes());
        assert!(result.is_some());
        let (payload, _) = result.unwrap();
        assert!(payload.contains("jsonrpc"));
    }

    #[test]
    fn test_empty_line_skipped() {
        let input = b"\n{\"next\":true}\n";
        let (payload, consumed) = try_extract_frame(input).unwrap();
        assert!(payload.is_empty());
        assert_eq!(consumed, 1);
    }

    #[test]
    fn test_frame_message() {
        let body = r#"{"hello":"world"}"#;
        let framed = frame_message(body);
        let text = String::from_utf8(framed).unwrap();
        assert!(text.starts_with("Content-Length: 17\r\n\r\n"));
        assert!(text.ends_with(body));
    }

    #[test]
    fn test_lf_only_header() {
        let body = r#"{"id":1}"#;
        let frame = format!("Content-Length: {}\n\n{}", body.len(), body);
        let result = try_extract_frame(frame.as_bytes());
        assert!(result.is_some());
        let (payload, _) = result.unwrap();
        assert_eq!(payload, body);
    }
}
