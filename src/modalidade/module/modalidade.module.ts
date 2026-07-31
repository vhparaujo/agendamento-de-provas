import { Module } from '@nestjs/common';
import { ModalidadeController } from '../controller/modalidade.controller';
import { ModalidadeService } from '../service/modalidade.service';

@Module({
  controllers: [ModalidadeController],
  providers: [ModalidadeService],
  exports: [ModalidadeService],
})
export class ModalidadeModule {}
