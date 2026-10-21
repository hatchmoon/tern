use std::{env, fs::File, io::{self, BufReader}, process};

// Uses the same upstream decoder crate as the native Flutter updater.
// This is an independent format check, not a Flutter engine or code runner.
fn verify() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 { return Err("Usage: tern-native-verifier BASE PATCH OUTPUT".into()); }
    let base = File::open(&args[1])?;
    let compressed = BufReader::new(File::open(&args[2])?);
    let decoded = zstd::stream::read::Decoder::new(compressed)?;
    let mut patched = bipatch::Reader::new(decoded, base)?;
    let mut output = File::options().write(true).create_new(true).open(&args[3])?;
    let bytes = io::copy(&mut patched, &mut output)?;
    println!("Reconstructed {bytes} bytes with upstream bipatch 1.0.0.");
    Ok(())
}
fn main() {
    if let Err(error) = verify() { eprintln!("{error}"); process::exit(1); }
}
