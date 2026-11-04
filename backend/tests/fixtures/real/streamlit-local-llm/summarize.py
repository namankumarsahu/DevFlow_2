import os
from gpt4all import GPT4All

# Force CPU only to bypass CUDA errors.
os.environ["LLAMA_CPP_FORCE_CPU"] = "1"
model = GPT4All("example-3b.gguf", model_path="C:/models")

def summarize(text):
    return model.generate(text)
