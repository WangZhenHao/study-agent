import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';

@Injectable()
export class ChatService {
  private apiUrl: string;
  private apiKey: string;
  private model: ChatOpenAI;

  constructor(private readonly config: ConfigService) {
    this.apiUrl = this.config.getOrThrow<string>('NEST_API_URL');
    this.apiKey = this.config.getOrThrow<string>('NEST_API_KEY');


    this.model = new ChatOpenAI({
      model: 'deepseek-v4-flash',
      apiKey: this.apiKey,
      configuration: {
        baseURL: this.apiUrl,
      }
    });
  }

  async sendMessage(content: string, sender: string) {
    try {
      const response = await this.model.invoke('你是什么模型');
      return response;
    } catch (error) {
      console.log(error);
      throw new BadGatewayException(error);
    }
  }
}
